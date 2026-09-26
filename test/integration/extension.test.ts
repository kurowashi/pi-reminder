import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import reminderExtension from "../../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** A slash command as registered by the extension. */
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;

/** The custom_message draft this extension returns at turn end. */
interface ReminderEntry {
	type: string;
	customType: string;
	display: boolean;
	content: string;
}

interface Harness {
	emit<T = unknown>(event: string, data: unknown): T;
	runCommand(args?: string): Promise<unknown>;
	ctx: ExtensionContext;
	statuses: (string | undefined)[];
	notifications: string[];
}

function harness(cwd: string, trusted = true): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const statuses: (string | undefined)[] = [];
	const notifications: string[] = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd,
		hasUI: true,
		isProjectTrusted: () => trusted,
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	reminderExtension(api);

	return {
		ctx,
		statuses,
		notifications,
		runCommand(args = "") {
			const handler = commands.get("reminder");
			if (!handler) throw new Error("the reminder command is not registered");
			return Promise.resolve(handler(args, ctx));
		},
		emit<T = unknown>(event: string, data: unknown): T {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = handler(data, ctx) ?? result;
			return result as T;
		},
	};
}

function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reminder-flow-"));
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

function withProject<T>(config: Record<string, unknown>, fn: (cwd: string) => T): T {
	return withTempDir((cwd) =>
		withTempDir((home) =>
			withAgentDir(home, () => {
				fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
				fs.writeFileSync(path.join(cwd, ".pi", "reminder.json"), JSON.stringify(config));
				return fn(cwd);
			}),
		),
	);
}

function assistantMessage(text: string, thinking = ""): unknown {
	return {
		role: "assistant",
		content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }],
		stopReason: "toolUse",
	};
}

function start(h: Harness): void {
	h.emit("session_start", { type: "session_start", reason: "startup" });
	h.emit("before_agent_start", { type: "before_agent_start" });
}

function textEvent(text: string, thinking = ""): unknown {
	return { type: "message_end", message: assistantMessage(text, thinking) };
}

function turnEnd(overrides: Record<string, unknown> = {}): unknown {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: assistantMessage("done"),
		toolResults: [],
		messageEntryId: "m1",
		toolResultEntryIds: [],
		outcome: "completed",
		entries: [],
		continue: false,
		// A turn that ended on an assistant message, as seen before this handler's draft.
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
		...overrides,
	};
}

test("transient mode injects the prompt into the next request exactly once", () => {
	withProject({ everyChars: 10, prompt: "CHECK THE LIST", mode: "transient" }, (cwd) => {
		const h = harness(cwd);
		start(h);

		h.emit("message_end", textEvent("12345"));
		assert.equal(h.statuses.at(-1), "🔔 5/10");

		h.emit("message_end", textEvent("678901"));
		assert.equal(h.statuses.at(-1), "🔔 11/10 →");

		const injected = h.emit<{ messages: Array<{ role: string; content: string }> }>("context", {
			type: "context",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		});
		assert.equal(injected.messages.length, 2);
		const reminder = injected.messages[1];
		assert.ok(reminder, "the reminder must be appended");
		assert.equal(reminder.role, "user");
		assert.equal(reminder.content, "[PERIODIC REMINDER]\nCHECK THE LIST");
		assert.equal(h.statuses.at(-1), "🔔 0/10");

		assert.equal(h.emit("context", { type: "context", messages: [] }), undefined);
	});
});

test("countThinking=false ignores thinking blocks", () => {
	withProject({ everyChars: 10, prompt: "CHECK", countThinking: false }, (cwd) => {
		const h = harness(cwd);
		start(h);
		h.emit("message_end", textEvent("ab", "x".repeat(100)));
		assert.equal(h.emit("context", { type: "context", messages: [] }), undefined);
	});
});

test("the assistant reaction to an injection is not counted as new work", () => {
	withProject({ everyChars: 10, prompt: "CHECK" }, (cwd) => {
		const h = harness(cwd);
		start(h);

		h.emit("message_end", textEvent("x".repeat(20)));
		assert.notEqual(h.emit("context", { type: "context", messages: [] }), undefined, "first injection");

		h.emit("message_end", textEvent("y".repeat(100)));
		assert.equal(
			h.emit("context", { type: "context", messages: [] }),
			undefined,
			"the reaction must not trigger another injection",
		);

		h.emit("message_end", textEvent("z".repeat(20)));
		assert.notEqual(h.emit("context", { type: "context", messages: [] }), undefined, "real work counts again");
	});
});

test("a new user turn resets the character budget", () => {
	withProject({ everyChars: 10, prompt: "CHECK" }, (cwd) => {
		const h = harness(cwd);
		start(h);
		h.emit("message_end", textEvent("12345678"));
		h.emit("before_agent_start", { type: "before_agent_start" });
		h.emit("message_end", textEvent("1234"));
		assert.equal(h.statuses.at(-1), "🔔 4/10");
	});
});

test("persistent mode stores the reminder at turn end and continues", () => {
	withProject({ everyChars: 5, prompt: "REVIEW", mode: "persistent", display: true }, (cwd) => {
		const h = harness(cwd);
		start(h);

		h.emit("message_end", textEvent("abcdef"));
		assert.equal(
			h.emit("context", { type: "context", messages: [] }),
			undefined,
			"persistent mode must not inject transiently",
		);

		const result = h.emit<{ continue: boolean; entries: ReminderEntry[] }>("turn_end", turnEnd());
		assert.equal(result.continue, true);
		assert.equal(result.entries.length, 1);
		const entry = result.entries[0];
		assert.ok(entry, "the reminder entry must be appended");
		assert.equal(entry.type, "custom_message");
		assert.equal(entry.customType, "reminder");
		assert.equal(entry.display, true);
		assert.equal(entry.content, "[PERIODIC REMINDER]\nREVIEW");

		assert.equal(h.emit("turn_end", turnEnd()), undefined, "must not inject twice");
	});
});

test("persistent mode does not continue on aborted or error turns", () => {
	withProject({ everyChars: 1, prompt: "REVIEW", mode: "persistent" }, (cwd) => {
		const h = harness(cwd);
		start(h);

		h.emit("message_end", textEvent("x"));
		assert.equal(h.emit("turn_end", turnEnd({ outcome: "aborted" })), undefined);

		const result = h.emit<{ continue: boolean }>("turn_end", turnEnd());
		assert.equal(result.continue, true, "the pending reminder survives until a completed turn");
	});
});

test("the /reminder command acts and reports, and rejects unknown actions", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reminder-command-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reminder-command-"));
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = home;
	try {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "reminder.json"),
			JSON.stringify({ everyChars: 1000, prompt: "CHECK", countThinking: false }),
		);
		const h = harness(cwd);
		start(h);

		await h.runCommand("now");
		assert.notEqual(h.emit("context", { type: "context", messages: [] }), undefined, "now must schedule one injection");

		await h.runCommand("status");
		const report = h.notifications.at(-1) ?? "";
		assert.match(report, /\(transient, every 1000 chars\)/, "status must report the effective config");
		assert.match(report, /prompt: 5 chars/);

		await h.runCommand("bogus");
		assert.match(h.notifications.at(-1) ?? "", /usage: \/reminder/, "unknown actions must warn, not act");
	} finally {
		if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = saved;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	}
});
