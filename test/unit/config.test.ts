import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, resolveConfig } from "../../src/config.ts";
import { assistantOutputChars, formatCount, reminderText } from "../../src/index.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reminder-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function withAgentDir<T>(dir: string, fn: () => T): T {
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = dir;
	try {
		return fn();
	} finally {
		if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = saved;
	}
}

function writeConfig(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

test("resolveConfig fills defaults and warns instead of throwing on bad values", () => {
	const warnings: string[] = [];
	assert.deepEqual(resolveConfig([], warnings), DEFAULT_CONFIG);
	assert.deepEqual(warnings, []);

	const resolved = resolveConfig([{ enabled: "yes", everyChars: -5, mode: "sometimes", prompt: 42 }], warnings);
	assert.equal(resolved.enabled, DEFAULT_CONFIG.enabled);
	assert.equal(resolved.everyChars, DEFAULT_CONFIG.everyChars);
	assert.equal(resolved.mode, DEFAULT_CONFIG.mode);
	assert.equal(resolved.prompt, DEFAULT_CONFIG.prompt);
	assert.equal(warnings.length, 4);
});

test("resolveConfig merges low precedence first and keeps valid values", () => {
	const resolved = resolveConfig(
		[
			{ everyChars: 1000, prompt: "global", display: false },
			{ everyChars: 500, mode: "persistent", display: true },
		],
		[],
	);
	assert.equal(resolved.everyChars, 500);
	assert.equal(resolved.prompt, "global");
	assert.equal(resolved.mode, "persistent");
	assert.equal(resolved.display, true);
});

test("loadConfig reads the global file and ignores untrusted project config", () => {
	withTempDir((home) =>
		withTempDir((cwd) => {
			withAgentDir(home, () => {
				writeConfig(path.join(home, "reminder.json"), { prompt: "from global", everyChars: 100 });
				writeConfig(path.join(cwd, ".pi", "reminder.json"), { prompt: "from project" });

				const trusted = loadConfig(cwd, true);
				assert.equal(trusted.config.prompt, "from project");
				assert.equal(trusted.config.everyChars, 100);
				assert.deepEqual(trusted.warnings, []);

				const untrusted = loadConfig(cwd, false);
				assert.equal(untrusted.config.prompt, "from global");
				assert.match(untrusted.warnings.join("\n"), /not trusted/);
			});
		}),
	);
});

test("loadConfig reports unreadable files as warnings", () => {
	withTempDir((home) =>
		withTempDir((cwd) => {
			withAgentDir(home, () => {
				fs.writeFileSync(path.join(home, "reminder.json"), "{ not json");
				const loaded = loadConfig(cwd, true);
				assert.equal(loaded.config.prompt, "");
				assert.match(loaded.warnings.join("\n"), /not valid JSON/);
			});
		}),
	);
});

test("assistantOutputChars counts text, tool arguments, and optionally thinking", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "abc" },
			{ type: "text", text: "12345" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" } },
		],
	};
	const toolArgs = JSON.stringify({ path: "/tmp/x" }).length;
	assert.equal(assistantOutputChars(message, false), 5 + toolArgs);
	assert.equal(assistantOutputChars(message, true), 8 + toolArgs);
	assert.equal(assistantOutputChars({ role: "user", content: "hello" }, true), 0);
	assert.equal(assistantOutputChars({ role: "assistant" }, true), 0);
});

test("reminderText and formatCount stay stable", () => {
	assert.equal(reminderText("CHECK"), "[PERIODIC REMINDER]\nCHECK");
	assert.equal(formatCount(999), "999");
	assert.equal(formatCount(1500), "1.5k");
	assert.equal(formatCount(25_000), "25k");
});
