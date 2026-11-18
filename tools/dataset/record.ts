// Recorded-payload capture: one Cargo query per invocation, by hand.
//
// This is deliberately *not* the fetch layer. `fetch.ts` is the crawler: it takes
// an explicit plan, issues sequential requests at a measured interval, backs off
// on `ratelimited`, and resumes from a cache keyed by the query. This tool exists
// so fixtures are recorded from the live API rather than invented, and it stays
// honest about its limits — one query per invocation, a gap from the newest
// recorded fetch, and a refusal to overwrite a payload that changed upstream
// without `--replace`. It shares the cache key and sidecar format, so the build
// cannot tell a hand-recorded fixture from a fetched payload.
//
//   node tools/dataset/record.ts --endpoint cargoexport \
//     --tables Tournaments \
//     --fields "Name,OverviewPage,DateStart" \
//     --where "OverviewPage='2023 Season World Championship'" \
//     --root tools/dataset/fixtures/raw
//
// Every invocation prints the query it used, so the query text travels with the
// payload: the sidecar in `raw/<source>/<action>/<key>.meta.json` records the URL,
// the fetch time, the HTTP status and the body hash (spec D7).

import { mkdir, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";

import type { CargoQuery } from "./cache.ts";
import { payloadDir, payloadPaths, queryUrl, sha256, tableOf, writePayload } from "./cache.ts";

/** Measured 2026-11-12: three or four Cargo requests trip the limiter for >100s. */
const DEFAULT_MIN_GAP_SECONDS = 75;

const USER_AGENT = "lol-dataset/0.1 (+https://github.com/RRiboulet/lol-dataset; fixture recording)";

async function newestFetchMs(root: string): Promise<number> {
	let newest = 0;
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name.endsWith(".meta.json")) {
				const meta = JSON.parse(await readFile(full, "utf8")) as { fetchedAt?: string };
				const at = Date.parse(meta.fetchedAt ?? "");
				if (Number.isFinite(at) && at > newest) newest = at;
			}
		}
	}
	await walk(root);
	return newest;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			endpoint: { type: "string", default: "cargoquery" },
			tables: { type: "string" },
			fields: { type: "string" },
			where: { type: "string" },
			"order-by": { type: "string" },
			limit: { type: "string" },
			offset: { type: "string" },
			root: { type: "string" },
			gap: { type: "string" },
			replace: { type: "boolean", default: false },
			dry: { type: "boolean", default: false },
		},
	});

	if (!values.tables || !values.fields || !values.root) {
		throw new Error("--tables, --fields and --root are required");
	}
	const endpoint = values.endpoint as "cargoquery" | "cargoexport";
	if (endpoint !== "cargoquery" && endpoint !== "cargoexport") throw new Error(`unknown --endpoint ${JSON.stringify(endpoint)}`);
	const query: CargoQuery = {
		endpoint,
		tables: values.tables,
		fields: values.fields,
		...(values.where === undefined ? {} : { where: values.where }),
		...(values["order-by"] === undefined ? {} : { order_by: values["order-by"] }),
		...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
		...(values.offset === undefined ? {} : { offset: Number(values.offset) }),
	};
	const url = queryUrl(query);
	if (values.dry) {
		console.log(url);
		return;
	}

	const gap = values.gap === undefined ? DEFAULT_MIN_GAP_SECONDS : Number(values.gap);
	const sinceLast = Date.now() - (await newestFetchMs(values.root));
	const waitMs = gap * 1000 - sinceLast;
	if (waitMs > 0) {
		console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the rate limiter (last fetch was ${Math.round(sinceLast / 1000)}s ago)`);
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}

	const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
	const body = await response.text();
	const fetchedAt = new Date().toISOString();
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 400)}`);
	const parsed = JSON.parse(body) as
		| unknown[]
		| { error?: { code?: string; info?: string }; cargoquery?: unknown[] };
	if (!Array.isArray(parsed) && parsed.error) {
		throw new Error(`API error ${parsed.error.code} for ${url}: ${parsed.error.info ?? ""}`);
	}
	const rowCount = Array.isArray(parsed) ? parsed.length : (parsed.cargoquery?.length ?? 0);

	const paths = payloadPaths(values.root, query);
	const previous = await readFile(paths.body, "utf8").catch(() => undefined);
	if (previous !== undefined) {
		if (sha256(previous) === sha256(body)) {
			console.log(`unchanged: ${paths.body} (${rowCount} rows)`);
			return;
		}
		if (!values.replace) {
			throw new Error(`${paths.body} already exists with different bytes; pass --replace to overwrite`);
		}
	}

	await mkdir(payloadDir(values.root, endpoint, tableOf(query)), { recursive: true });
	await writePayload(values.root, query, body, { url, fetchedAt, status: response.status });
	console.log(`recorded ${rowCount} rows -> ${paths.body}`);
	if (rowCount === 0) console.log("warning: the query returned no rows; check --where quoting");
}

await main();
