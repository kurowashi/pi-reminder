/**
 * Contract: the model-facing surface stays empty, and the documented events exist.
 *
 * pi-reminder is injection-only. A registered tool would be re-sent to the
 * model on every request for the rest of the session, which is exactly the
 * permanent context tax this extension exists to avoid. Commands are
 * user-initiated and cost the model nothing.
 *
 * The extension is loaded through Pi's own loader (jiti), the same path Pi
 * uses at runtime, so these assertions cover the shipped artifact rather than
 * a re-import of the modules under test. The loader also scans project and
 * global extension directories, so both are redirected to an empty sandbox.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions, type Extension, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../helpers/root.ts";

/** The behaviors the README documents, one registration each. */
const EXPECTED_EVENTS = ["before_agent_start", "context", "message_end", "session_start", "turn_end"];

async function loadReminderExtension(): Promise<Extension> {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-reminder-surface-"));
	const result: LoadExtensionsResult = await discoverAndLoadExtensions(
		[join(PACKAGE_ROOT, "src", "index.ts")],
		sandbox,
		sandbox,
	);
	assert.deepEqual(result.errors, [], "the extension must load without errors");
	const extension = result.extensions[0];
	assert.ok(extension, "the loader must return the extension");
	assert.equal(result.extensions.length, 1, "the sandbox must load only this extension");
	return extension;
}

test("no tools are registered", async () => {
	const extension = await loadReminderExtension();
	assert.deepEqual([...extension.tools.keys()], [], "a tool would tax every request; inject through events instead");
});

test("the /reminder command and nothing else is registered", async () => {
	const extension = await loadReminderExtension();
	assert.deepEqual([...extension.commands.keys()], ["reminder"]);
});

test("every documented event has exactly one handler", async () => {
	const extension = await loadReminderExtension();
	assert.deepEqual([...extension.handlers.keys()].sort(), EXPECTED_EVENTS);
	for (const event of EXPECTED_EVENTS) {
		assert.equal(extension.handlers.get(event)?.length, 1, `${event} must have exactly one handler`);
	}
});
