// emit: records -> bytes, with nothing left to chance.
//
// Determinism (spec R8) is mostly ordering, which `assemble.ts` owns, but two
// things belong here: the serialization itself (one JSON object per line, LF, no
// BOM, one trailing newline) and the refusal to serialize a record with an
// `undefined` value. `JSON.stringify` drops such a key silently, which would turn
// a missing field into a schema violation two stages later instead of a naming
// error here.
//
// Field order is the record's own construction order (see `assemble.ts`): JSON
// preserves insertion order, so a stable record definition gives a stable line, and
// a one-field change shows as a one-field diff.

/** Why a record cannot be serialized at all — a bug in this pipeline, not in the data. */
function assertSerializable(record: unknown, index: number): void {
	if (record === null || typeof record !== "object" || Array.isArray(record)) {
		throw new Error(`record ${index}: expected an object, got ${Array.isArray(record) ? "array" : typeof record}`);
	}
	for (const [key, value] of Object.entries(record)) {
		if (value === undefined) throw new Error(`record ${index}: field ${JSON.stringify(key)} is undefined`);
	}
}

/** JSONL: one compact object per line, sorted already, trailing newline if non-empty. */
export function toJsonl(records: readonly unknown[]): string {
	records.forEach((record, index) => assertSerializable(record, index));
	if (records.length === 0) return "";
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
