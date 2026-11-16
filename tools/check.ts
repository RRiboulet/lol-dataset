// check: the repository's whole quality gate in one command (ticket 06).
//
//   node tools/check.ts
//
// "Is the repo green" used to be a multi-command question — the dataset suite, then
// the scaffold suite, with the second easily forgotten. This runs both, in the order
// AGENTS.md lists them, and exits non-zero if either fails. It is a thin runner on
// purpose: each suite keeps owning its own tests, and this only decides what "all of
// them" means.
//
// The scaffold suite needs `node_modules` linked into this checkout, which
// `.pi/extensions/subagent/test/setup-deps.sh` does. That script is idempotent, so
// running it here is what makes the command work on a fresh clone without a separate
// setup step.

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

type Suite = {
	name: string;
	/** Directory holding the suite's `*.test.ts` files. */
	root: string;
	/** Run before the suite; the scaffold tests import pi's packages by link. */
	prepare?: { command: string; args: string[] };
};

const SUITES: Suite[] = [
	{ name: "dataset", root: "tools/dataset/test" },
	{
		name: "scaffold",
		root: ".pi/extensions/subagent/test",
		prepare: { command: "bash", args: [".pi/extensions/subagent/test/setup-deps.sh"] },
	},
];

function run(command: string, args: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		// `glob` is off: node expands the `*.test.ts` patterns itself on this version,
		// and a shell would expand them differently or not at all depending on where it
		// runs from.
		const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit", shell: false });
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

/**
 * The suite's test files, enumerated rather than globbed.
 *
 * A glob would be expanded by the shell in AGENTS.md's commands but not here, where
 * `spawn` runs without one; letting node interpret the pattern would make the result
 * depend on the node version, and a pattern that matches nothing exits successfully —
 * a green run that tested nothing. Enumerating the directory makes that impossible.
 */
async function testFiles(root: string): Promise<string[]> {
	const dir = path.join(REPO_ROOT, root);
	const names = await readdir(dir);
	const files = names.filter((name) => name.endsWith(".test.ts")).sort();
	if (files.length === 0) throw new Error(`${root}: no *.test.ts files found — a suite that runs nothing is not green`);
	return files.map((name) => path.join(root, name));
}

async function main(): Promise<void> {
	const failures: string[] = [];
	for (const suite of SUITES) {
		console.log(`\n==> ${suite.name} suite`);
		if (suite.prepare !== undefined) {
			const prepared = await run(suite.prepare.command, suite.prepare.args);
			if (prepared !== 0) {
				failures.push(`${suite.name} (setup)`);
				continue;
			}
		}
		const code = await run("node", ["--test", ...(await testFiles(suite.root))]);
		if (code !== 0) failures.push(suite.name);
	}
	if (failures.length > 0) {
		console.error(`\nfailed: ${failures.join(", ")}`);
		process.exitCode = 1;
		return;
	}
	console.log(`\nall suites passed: ${SUITES.map((suite) => suite.name).join(", ")}`);
}

await main();
