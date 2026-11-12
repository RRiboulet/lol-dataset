// The schema validator itself: it must reject what the schema rejects, and it must
// refuse a keyword it does not implement rather than silently ignoring it.
//
// The second half matters more than the first. A validator that quietly skips an
// unknown keyword turns every later schema edit into a no-op, and the failure shows
// up as "the schema says it is valid" over data it never checked.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { buildDataset } from "../build.ts";
import { assertValid, validateAgainst } from "../validate.ts";
import { FIXTURE_RAW, SCHEMA_DIR } from "./helpers.ts";

async function schema(name: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(SCHEMA_DIR, name), "utf8")) as Record<string, unknown>;
}

async function sampleEvent(): Promise<Record<string, unknown>> {
	const { events } = await buildDataset({ rawDir: FIXTURE_RAW });
	return events[0] as unknown as Record<string, unknown>;
}

test("a real emitted event satisfies the checked-in event schema", async () => {
	const { events } = await buildDataset({ rawDir: FIXTURE_RAW });
	for (const event of events) {
		assert.deepEqual(validateAgainst(await schema("event.schema.json"), event, "event.schema.json"), []);
	}
});

test("every committed report row satisfies the checked-in selection schema, including absent regions", async () => {
	const selectionSchema = await schema("event-selection.schema.json");
	const { selection } = await buildDataset({ rawDir: FIXTURE_RAW });
	// The unknown-region fixture has an empty league; the schema must allow it,
	// because "the source recorded nothing" is a value the report has to carry.
	assert.ok(selection.some((record) => record.region === "Unknown"));
	for (const record of selection) {
		assert.deepEqual(validateAgainst(selectionSchema, record, "event-selection.schema.json"), []);
	}
});

test("a missing required field is reported by name", async () => {
	const event = await sampleEvent();
	delete event.name;
	const errors = validateAgainst(await schema("event.schema.json"), event);
	assert.deepEqual(errors, [{ path: "", message: 'missing required field "name"' }]);
});

test("an unexpected field is rejected, so the schema stays the contract", async () => {
	const event = await sampleEvent();
	event.surprise = true;
	const errors = validateAgainst(await schema("event.schema.json"), event);
	assert.deepEqual(errors, [{ path: "", message: 'unexpected field "surprise"' }]);
});

test("a field's own constraints fire, with the path that names it", async () => {
	const eventSchema = await schema("event.schema.json");
	const event = await sampleEvent();

	const badId = { ...event, id: "2023-worlds" };
	assert.deepEqual(validateAgainst(eventSchema, badId), [{ path: "id", message: '"2023-worlds" does not match ^evt-[0-9a-f]{12}$' }]);

	const badYear = { ...event, year: "2023" };
	assert.deepEqual(validateAgainst(eventSchema, badYear), [{ path: "year", message: "expected integer, got string" }]);

	const badRule = { ...event, selection: { ...(event.selection as object), rule: "hand-listed" } };
	assert.deepEqual(validateAgainst(eventSchema, badRule), [{ path: "selection.rule", message: '"hand-listed" is not one of ["admitted","override"]' }]);

	const nestedMissing = { ...event, selection: { key: "worlds" } };
	assert.deepEqual(validateAgainst(eventSchema, nestedMissing), [{ path: "selection", message: 'missing required field "rule"' }]);
});

test("an unsupported schema keyword is an error, not a silent pass", async () => {
	// `format` is a real JSON Schema keyword this validator does not implement.
	const eventSchema = await schema("event.schema.json");
	const withFormat = JSON.parse(JSON.stringify(eventSchema)) as { properties: Record<string, Record<string, unknown>> };
	withFormat.properties.dateStart.format = "date";
	const event = await sampleEvent();
	assert.throws(() => validateAgainst(withFormat, event), /unsupported schema keyword "format"/);
});

test("assertValid lists every problem in one failure", async () => {
	const event = await sampleEvent();
	const broken = { ...event, id: "nope", year: "2023" };
	const eventSchema = await schema("event.schema.json");
	assert.throws(() => assertValid(eventSchema, broken, "events.jsonl:7"), /events\.jsonl:7\.id: .*\n {2}- events\.jsonl:7\.year: /s);
});
