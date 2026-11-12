// The fetch seam: a fake transport and a fake clock, never a real request.
//
// Spec test seam S3. The point of the fake clock is that spacing and backoff are
// asserted as numbers the production loop asked to sleep, not as wall-clock
// tolerances a slow CI machine can fail. The fake transport answers with recorded
// envelopes, including the measured `ratelimited` body that arrives with HTTP 200.
//
// The cache itself is real: every test writes into a scratch directory under the
// OS temp dir, so "skipped", "resumed" and "no duplicate entries" are checks on
// files rather than on a mock's call log.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { CargoEndpoint, CargoQuery } from "../cache.ts";
import { cacheKey, payloadPaths, queryUrl, readPayload } from "../cache.ts";
import type { Transport, TransportResponse } from "../fetch.ts";
import { FetchStoppedError, fetchQueries, parsePlan } from "../fetch.ts";

const START = Date.parse("2026-11-12T00:00:00Z");

type Call = { url: string; at: number; headers: Record<string, string>; index: number };
type Reply = (call: Call) => TransportResponse | Promise<TransportResponse>;

/** A clock the test advances, and a transport that records when it was called. */
function harness(reply: Reply): {
	clock: { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] };
	calls: Call[];
	transport: Transport;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
} {
	let time = START;
	const sleeps: number[] = [];
	const calls: Call[] = [];
	const transport: Transport = async (request) => {
		const call = { url: request.url, at: time, headers: request.headers, index: calls.length };
		calls.push(call);
		return reply(call);
	};
	return {
		clock: {
			now: () => time,
			sleep: async (ms: number) => {
				sleeps.push(ms);
				time += ms;
			},
			sleeps,
		},
		calls,
		transport,
		now: () => time,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			time += ms;
		},
	};
}

function query(where: string, endpoint: CargoEndpoint = "cargoexport"): CargoQuery {
	return { endpoint, tables: "Tournaments", fields: "Name,OverviewPage", where, limit: 10 };
}

/** The `Special:CargoExport` envelope: a bare array of rows. */
function exportBody(name: string): string {
	return JSON.stringify([{ Name: name, OverviewPage: name }]);
}

/** The `api.php?action=cargoquery` envelope: rows wrapped in `cargoquery`/`title`. */
function apiBody(name: string): string {
	return JSON.stringify({ cargoquery: [{ title: { Name: name, OverviewPage: name } }] });
}

const RATE_LIMITED: TransportResponse = {
	status: 200,
	body: JSON.stringify({ error: { code: "ratelimited", info: "You have been rate limited. Try again later." } }),
};

async function scratch(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "dataset-fetch-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function cacheFiles(dir: string): Promise<{ bodies: string[]; metas: string[]; temps: string[] }> {
	const bodies: string[] = [];
	const metas: string[] = [];
	const temps: string[] = [];
	async function walk(current: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name.includes(".tmp-")) temps.push(full);
			else if (entry.name.endsWith(".meta.json")) metas.push(full);
			else if (entry.name.endsWith(".json")) bodies.push(full);
		}
	}
	await walk(dir);
	return { bodies, metas, temps };
}

test("requests are sequential and spaced by the interval plus jitter, on both envelopes", async (t) => {
	const dir = await scratch(t);
	const h = harness(({ index }) => ({ status: 200, body: index === 0 ? exportBody("A") : apiBody("B") }));
	const queries = [query("A"), query("B", "cargoquery")];

	const result = await fetchQueries({
		queries,
		root: dir,
		intervalMs: 1000,
		jitterMs: 400,
		backoffMs: 5000,
		maxAttempts: 2,
		random: () => 0.5,
		now: h.now,
		sleep: h.sleep,
		transport: h.transport,
	});

	assert.equal(result.requests, 2);
	assert.equal(result.fetched.length, 2);
	assert.equal(h.calls.length, 2);
	// floor(0.5 * 400) = 200, so the second request starts 1200ms after the first.
	assert.equal(h.calls[1].at - h.calls[0].at, 1200);
	assert.deepEqual(h.clock.sleeps, [1200], "spacing must be a fake-clock sleep, not a real one");

	for (const [endpoint, name] of [["cargoexport", "A"], ["cargoquery", "B"]] as [CargoEndpoint, string][]) {
		const cached = await readPayload(dir, query(name, endpoint));
		assert.ok(cached, `${endpoint} payload must be cached`);
		const parsed = JSON.parse(cached.body) as unknown[] | { cargoquery: unknown[] };
		const rows = Array.isArray(parsed) ? parsed : parsed.cargoquery;
		assert.equal(rows.length, 1, `${endpoint} must keep its own envelope`);
		assert.equal(cached.meta.status, 200);
	}
	const files = await cacheFiles(dir);
	assert.equal(files.bodies.length, 2);
	assert.equal(files.metas.length, 2);
	assert.deepEqual(files.temps, [], "an atomic write must not leave temporary files behind");
});

test("a rate-limit body with HTTP 200 backs off, retries, and is never cached as a payload", async (t) => {
	const dir = await scratch(t);
	const h = harness(({ index }) => (index < 2 ? RATE_LIMITED : { status: 200, body: apiBody("eventually") }));
	const queries = [query("eventually", "cargoquery")];

	const result = await fetchQueries({
		queries,
		root: dir,
		intervalMs: 1000,
		jitterMs: 0,
		backoffMs: 5000,
		maxAttempts: 4,
		now: h.now,
		sleep: h.sleep,
		transport: h.transport,
	});

	assert.equal(result.requests, 3, "two refusals and one success");
	assert.equal(result.fetched.length, 1);
	assert.deepEqual(h.clock.sleeps, [5000, 10000], "backoff must double, and no interval sleep is added on top");

	const cached = await readPayload(dir, queries[0]);
	assert.ok(cached);
	assert.match(cached.body, /eventually/);
	assert.doesNotMatch(cached.body, /ratelimited/, "the refusal must never become the cached body");
	assert.equal(cached.meta.status, 200);
});

test("repeated failures stop the run with a message naming what to resume", async (t) => {
	const dir = await scratch(t);
	const h = harness(({ index }) => (index === 0 ? { status: 200, body: exportBody("done") } : RATE_LIMITED));
	const queries = [query("done"), query("not-yet", "cargoquery")];

	await assert.rejects(
		fetchQueries({
			queries,
			root: dir,
			intervalMs: 0,
			jitterMs: 0,
			backoffMs: 7000,
			maxAttempts: 3,
			now: h.now,
			sleep: h.sleep,
			transport: h.transport,
		}),
		(error: unknown) => {
			assert.ok(error instanceof FetchStoppedError);
			assert.match(error.message, /ratelimited/);
			assert.match(error.message, /query: .*not-yet/);
			assert.match(error.message, new RegExp(cacheKey(queries[1])));
			assert.match(error.message, /Re-run the same plan to resume/);
			assert.equal(error.stop.fetched, 1, "the successful payload stays cached for the resume");
			assert.equal(error.stop.query.where, "not-yet");
			return true;
		},
	);

	assert.equal(h.calls.length, 1 + 3);
	assert.deepEqual(h.clock.sleeps, [7000, 14000], "retries are bounded, not an infinite loop");
	const files = await cacheFiles(dir);
	assert.equal(files.bodies.length, 1, "only the payload was written; three refusals left no files");
	assert.equal(files.metas.length, 1);
});

test("a non-rate-limit API error is a failure, not an empty result", async (t) => {
	const dir = await scratch(t);
	const h = harness(() => ({ status: 200, body: JSON.stringify({ error: { code: "badquery", info: "no such field" } }) }));

	await assert.rejects(
		fetchQueries({
			queries: [query("broken")],
			root: dir,
			intervalMs: 0,
			jitterMs: 0,
			backoffMs: 100,
			maxAttempts: 1,
			now: h.now,
			sleep: h.sleep,
			transport: h.transport,
		}),
		/API error badquery: no such field/,
	);
	assert.equal((await cacheFiles(dir)).bodies.length, 0);
});

test("a second run over a complete cache issues zero requests", async (t) => {
	const dir = await scratch(t);
	const queries = [query("A"), query("B")];
	const first = harness(({ index }) => ({ status: 200, body: exportBody(index === 0 ? "A" : "B") }));
	await fetchQueries({
		queries,
		root: dir,
		intervalMs: 1000,
		jitterMs: 500,
		backoffMs: 1000,
		maxAttempts: 1,
		now: first.now,
		sleep: first.sleep,
		transport: first.transport,
	});
	assert.equal(first.calls.length, 2);

	const second = harness(() => {
		throw new Error("a complete cache must not request anything");
	});
	const result = await fetchQueries({
		queries,
		root: dir,
		intervalMs: 1000,
		jitterMs: 500,
		backoffMs: 1000,
		maxAttempts: 1,
		now: second.now,
		sleep: second.sleep,
		transport: second.transport,
	});
	assert.equal(result.requests, 0);
	assert.equal(result.fetched.length, 0);
	assert.equal(result.skipped.length, 2);
	assert.deepEqual(second.clock.sleeps, [], "a cached run must not even wait for an interval");
});

test("reordering the plan does not invalidate cached work", async (t) => {
	const dir = await scratch(t);
	const a = query("A");
	const b = query("B");
	const first = harness(({ index }) => ({ status: 200, body: exportBody(index === 0 ? "A" : "B") }));
	await fetchQueries({
		queries: [a, b],
		root: dir,
		intervalMs: 0,
		jitterMs: 0,
		backoffMs: 1000,
		maxAttempts: 1,
		now: first.now,
		sleep: first.sleep,
		transport: first.transport,
	});

	const second = harness(() => {
		throw new Error("reordering must not re-fetch");
	});
	const result = await fetchQueries({
		queries: [b, a],
		root: dir,
		intervalMs: 0,
		jitterMs: 0,
		backoffMs: 1000,
		maxAttempts: 1,
		now: second.now,
		sleep: second.sleep,
		transport: second.transport,
	});
	assert.equal(result.requests, 0);
	assert.equal(result.skipped.length, 2);
});

test("an interrupted run resumes and fetches only what is missing", async (t) => {
	const dir = await scratch(t);
	const queries = [query("A"), query("B"), query("C")];

	const interrupted = harness(({ index }) => {
		if (index === 0) return { status: 200, body: exportBody("A") };
		if (index === 1) return { status: 200, body: exportBody("B") };
		throw new Error("connection reset by peer");
	});
	await assert.rejects(
		fetchQueries({
			queries,
			root: dir,
			intervalMs: 100,
			jitterMs: 0,
			backoffMs: 1000,
			maxAttempts: 1,
			now: interrupted.now,
			sleep: interrupted.sleep,
			transport: interrupted.transport,
		}),
		/transport failed: connection reset by peer/,
	);
	assert.equal((await cacheFiles(dir)).bodies.length, 2, "the first two payloads survived the interruption");

	const resumed = harness(() => ({ status: 200, body: exportBody("C") }));
	const result = await fetchQueries({
		queries,
		root: dir,
		intervalMs: 100,
		jitterMs: 0,
		backoffMs: 1000,
		maxAttempts: 1,
		now: resumed.now,
		sleep: resumed.sleep,
		transport: resumed.transport,
	});
	assert.equal(result.skipped.length, 2);
	assert.equal(result.fetched.length, 1);
	assert.equal(result.requests, 1, "only the missing query is requested");
	assert.equal(resumed.calls.length, 1);
	assert.equal(resumed.calls[0].url, queryUrl(queries[2]));

	const files = await cacheFiles(dir);
	assert.equal(files.bodies.length, 3);
	assert.equal(files.metas.length, 3);
	const keys = files.bodies.map((file) => path.basename(file));
	assert.equal(new Set(keys).size, keys.length, "no query may own two cache entries");
});

test("a plan that names the same query twice writes one cache entry", async (t) => {
	const dir = await scratch(t);
	const h = harness(() => ({ status: 200, body: exportBody("once") }));
	const repeated = query("once");

	const result = await fetchQueries({
		queries: [repeated, repeated],
		root: dir,
		intervalMs: 0,
		jitterMs: 0,
		backoffMs: 1000,
		maxAttempts: 1,
		now: h.now,
		sleep: h.sleep,
		transport: h.transport,
	});
	assert.equal(result.requests, 1);
	assert.equal(result.fetched.length, 1);
	assert.equal(result.skipped.length, 1);
	const files = await cacheFiles(dir);
	assert.equal(files.bodies.length, 1);
	assert.equal(files.metas.length, 1);
});

test("a body without its sidecar is incomplete, so the query is fetched again", async (t) => {
	const dir = await scratch(t);
	const pending = query("half-written");
	const paths = payloadPaths(dir, pending);
	await mkdir(path.dirname(paths.body), { recursive: true });
	await writeFile(paths.body, exportBody("old bytes"), "utf8");

	const h = harness(() => ({ status: 200, body: exportBody("new bytes") }));
	const result = await fetchQueries({
		queries: [pending],
		root: dir,
		intervalMs: 0,
		jitterMs: 0,
		backoffMs: 1000,
		maxAttempts: 1,
		now: h.now,
		sleep: h.sleep,
		transport: h.transport,
	});
	assert.equal(result.requests, 1, "a missing sidecar must not be treated as a complete cache entry");

	const cached = await readPayload(dir, pending);
	assert.ok(cached);
	assert.match(cached.body, /new bytes/);
	assert.match(await readFile(paths.meta, "utf8"), /"bodySha256"/);
	assert.deepEqual((await cacheFiles(dir)).temps, []);
});

test("fetch reads no credential from the environment and sends none", async (t) => {
	const dir = await scratch(t);
	const sentinel = `secret-${process.pid}-do-not-read-me`;
	const previous = process.env.LOL_DATASET_TEST_SECRET;
	process.env.LOL_DATASET_TEST_SECRET = sentinel;
	const h = harness(() => ({ status: 200, body: exportBody("public") }));
	try {
		await fetchQueries({
			queries: [query("public")],
			root: dir,
			intervalMs: 0,
			jitterMs: 0,
			backoffMs: 1000,
			maxAttempts: 1,
			now: h.now,
			sleep: h.sleep,
			transport: h.transport,
		});
	} finally {
		if (previous === undefined) delete process.env.LOL_DATASET_TEST_SECRET;
		else process.env.LOL_DATASET_TEST_SECRET = previous;
	}

	assert.equal(h.calls.length, 1);
	assert.deepEqual(Object.keys(h.calls[0].headers).sort(), ["Accept", "User-Agent"]);
	assert.ok(h.calls[0].headers["User-Agent"].length > 0);
	assert.doesNotMatch(JSON.stringify(h.calls[0]), /cookie|authorization|secret|token/i);

	for (const file of (await cacheFiles(dir)).bodies.concat((await cacheFiles(dir)).metas)) {
		assert.doesNotMatch(await readFile(file, "utf8"), new RegExp(sentinel));
	}
	// The module itself must not have an environment-reading path to a credential.
	const source = await readFile(path.join(import.meta.dirname, "..", "fetch.ts"), "utf8");
	assert.doesNotMatch(source, /process\.env/);
	assert.doesNotMatch(source, /document\.cookie|localStorage|sessionStorage/);
});

test("an explicit plan is parsed strictly, so a typo cannot silently change the query", () => {
	const good = [{ endpoint: "cargoexport", tables: "Tournaments", fields: "Name" }];
	assert.deepEqual(parsePlan(JSON.stringify(good), "test"), good);
	assert.deepEqual(parsePlan(JSON.stringify({ queries: good }), "test"), good);
	assert.throws(() => parsePlan("[]", "test"), /non-empty/);
	assert.throws(() => parsePlan(JSON.stringify([...good, { endpoint: "cargoexport", tables: "T", fields: "F", orderBy: "x" }]), "test"), /unknown query field "orderBy"/);
	assert.throws(() => parsePlan(JSON.stringify([{ endpoint: "cargoquery", tables: "", fields: "F" }]), "test"), /tables must be a non-empty string/);
	assert.throws(() => parsePlan(JSON.stringify([{ endpoint: "cargoexport", tables: "T", fields: "F", limit: -1 }]), "test"), /limit must be a non-negative integer/);
});
