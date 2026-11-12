// validate: the checked-in JSON Schema actually decides whether output ships.
//
// The repository has no dependency budget for `ajv` and no build step (AGENTS.md),
// so this is a deliberately small validator for the keyword subset the committed
// schemas use. Two rules keep "small" from meaning "quiet":
//
//   - an unsupported keyword is an error, never ignored. A schema that grows a
//     keyword this file does not implement fails loudly instead of validating
//     nothing, which is the failure mode that matters.
//   - errors name the field path and the constraint, because the point of a
//     validation failure is to tell someone which record to open.
//
// Ticket 06 brings the full invariant gate (referential and arithmetic checks on
// top of structural ones). This covers structure, which is what ticket 01 emits.

export type ValidationError = { path: string; message: string };

type Schema = Record<string, unknown>;

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "examples", "default"]);
const ASSERTIONS = new Set([
	"type",
	"required",
	"properties",
	"additionalProperties",
	"enum",
	"const",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"items",
	"minItems",
	"maxItems",
	"uniqueItems",
]);

/** Compile-time shape check: every keyword must be annotation or assertion. */
function assertKnownKeywords(schema: Schema, where: string): void {
	for (const keyword of Object.keys(schema)) {
		if (ANNOTATIONS.has(keyword) || ASSERTIONS.has(keyword)) continue;
		throw new Error(`${where}: unsupported schema keyword ${JSON.stringify(keyword)} — extend validate.ts rather than ignore it`);
	}
	for (const [name, child] of Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {})) {
		assertKnownKeywords(child, `${where}.properties.${name}`);
	}
	if (schema.items && typeof schema.items === "object") assertKnownKeywords(schema.items as Schema, `${where}.items`);
}

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (Number.isInteger(value)) return "integer";
	return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
	if (expected === "number") return typeof value === "number" && Number.isFinite(value);
	if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
	if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
	return typeOf(value) === expected;
}

function check(schema: Schema, value: unknown, path: string, errors: ValidationError[]): void {
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
		if (!types.some((type) => matchesType(value, type))) {
			errors.push({ path, message: `expected ${types.join(" or ")}, got ${typeOf(value)}` });
			return; // Further assertions assume the type held.
		}
	}
	if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(value)) {
		errors.push({ path, message: `${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}` });
	}
	if (schema.const !== undefined && value !== schema.const) {
		errors.push({ path, message: `expected the constant ${JSON.stringify(schema.const)}` });
	}

	if (typeof value === "string") {
		if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
			errors.push({ path, message: `${JSON.stringify(value)} does not match ${schema.pattern}` });
		}
		if (typeof schema.minLength === "number" && value.length < schema.minLength) {
			errors.push({ path, message: `shorter than ${schema.minLength} characters` });
		}
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
			errors.push({ path, message: `longer than ${schema.maxLength} characters` });
		}
	}

	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) errors.push({ path, message: `below the minimum ${schema.minimum}` });
		if (typeof schema.maximum === "number" && value > schema.maximum) errors.push({ path, message: `above the maximum ${schema.maximum}` });
	}

	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push({ path, message: `fewer than ${schema.minItems} items` });
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push({ path, message: `more than ${schema.maxItems} items` });
		if (schema.uniqueItems === true) {
			const seen = new Set(value.map((item) => JSON.stringify(item)));
			if (seen.size !== value.length) errors.push({ path, message: "items are not unique" });
		}
		if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
			const itemSchema = schema.items as Schema;
			value.forEach((item, index) => check(itemSchema, item, `${path}[${index}]`, errors));
		}
	}

	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
		for (const key of (schema.required as string[] | undefined) ?? []) {
			if (!(key in record)) errors.push({ path, message: `missing required field ${JSON.stringify(key)}` });
		}
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (key in record) check(propertySchema, record[key], path === "" ? key : `${path}.${key}`, errors);
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(record)) {
				if (!(key in properties)) errors.push({ path, message: `unexpected field ${JSON.stringify(key)}` });
			}
		} else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
			const extra = schema.additionalProperties as Schema;
			for (const [key, child] of Object.entries(record)) {
				if (!(key in properties)) check(extra, child, path === "" ? key : `${path}.${key}`, errors);
			}
		}
	}
}

/** Every violation of `schema` by `value`, with a path such as `selection.key`. */
export function validateAgainst(schema: Schema, value: unknown, where = "schema"): ValidationError[] {
	assertKnownKeywords(schema, where);
	const errors: ValidationError[] = [];
	check(schema, value, "", errors);
	return errors;
}

/** Throw with every problem listed, so one run reports all of them. */
export function assertValid(schema: Schema, value: unknown, subject: string, where = "schema"): void {
	const errors = validateAgainst(schema, value, where);
	if (errors.length === 0) return;
	const lines = errors.map((error) => `${subject}${error.path === "" ? "" : `.${error.path}`}: ${error.message}`);
	throw new Error(`${subject} does not satisfy the schema:\n  - ${lines.join("\n  - ")}`);
}
