/**
 * pi-reminder - Inject a configured prompt into the agent loop on a character budget.
 *
 * The extension counts assistant output (visible text, tool-call arguments, and
 * optionally thinking) and once the configured budget is exhausted it injects the
 * reminder into the next model request. This is the "every N characters, re-check
 * the checklist" pattern for long reasoning -> tool call -> reasoning loops.
 *
 * Injection mode:
 *  - "transient" (default): the reminder is appended to the request context only.
 *    Nothing is stored and no extra model request is forced, so the model reads
 *    it together with the next tool result or before its next answer.
 *  - "persistent": at turn end the reminder is stored in the session as a custom
 *    message and one continuation is requested, so the model always has to react
 *    to it and later turns still see it.
 *
 * Config files: ~/.pi/agent/reminder.json (or $PI_CODING_AGENT_DIR/reminder.json)
 * and <cwd>/.pi/reminder.json for trusted projects. See README.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, type ReminderConfig } from "./config.ts";

export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	arguments?: unknown;
}

/** Characters contributed by one content block. Unknown blocks are free. */
function blockChars(block: ContentBlock, countThinking: boolean): number {
	switch (block.type) {
		case "text":
			return (block.text ?? "").length;
		case "thinking":
			return countThinking ? (block.thinking ?? "").length : 0;
		case "toolCall":
			return JSON.stringify(block.arguments ?? {}).length;
		default:
			return 0;
	}
}

/**
 * Characters of model output in one assistant message: visible text, optionally
 * thinking, and tool-call arguments (the JSON the model wrote for the call).
 */
export function assistantOutputChars(message: { role: string; content?: unknown }, countThinking: boolean): number {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return 0;
	let chars = 0;
	for (const block of message.content as ContentBlock[]) chars += blockChars(block, countThinking);
	return chars;
}

/** The injected text. The header makes the origin obvious to the model. */
export function reminderText(prompt: string): string {
	return `[PERIODIC REMINDER]\n${prompt}`;
}

/** Compact character count for the status line. */
export function formatCount(chars: number): string {
	if (chars < 1000) return String(chars);
	const thousands = chars / 1000;
	return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

export default function reminderExtension(pi: ExtensionAPI): void {
	let config: ReminderConfig = DEFAULT_CONFIG;
	let warnings: string[] = [];
	let globalFile = "";
	let projectFile = "";
	let charsSinceInjection = 0;
	let pending = false;
	let skipNextAssistant = false;
	let announced = false;

	const reload = (ctx: ExtensionContext): void => {
		const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		config = loaded.config;
		warnings = loaded.warnings;
		globalFile = loaded.globalFile;
		projectFile = loaded.projectFile;
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!config.enabled) {
			ctx.ui.setStatus("reminder", ctx.ui.theme.fg("muted", "🔔 off"));
			return;
		}
		const progress = `${formatCount(charsSinceInjection)}/${formatCount(config.everyChars)}`;
		ctx.ui.setStatus("reminder", ctx.ui.theme.fg("accent", `🔔 ${pending ? `${progress} →` : progress}`));
	};

	/** A new user turn starts a fresh budget: reminders are per request, not per session. */
	const resetBudget = (): void => {
		charsSinceInjection = 0;
		pending = false;
		skipNextAssistant = false;
	};

	/** Spend the budget and ignore the assistant message that reacts to the reminder. */
	const consumeBudget = (): void => {
		charsSinceInjection = 0;
		pending = false;
		skipNextAssistant = true;
	};

	const announceWarnings = (ctx: ExtensionContext): void => {
		if (announced) return;
		announced = true;
		if (config.enabled && !config.prompt.trim()) {
			warnings.push(`reminder: prompt is empty; set it in ${globalFile}`);
		}
		if (ctx.hasUI) {
			for (const warning of warnings) ctx.ui.notify(`pi-reminder: ${warning}`, "warning");
		}
	};

	pi.on("session_start", (_event, ctx) => {
		reload(ctx);
		resetBudget();
		announceWarnings(ctx);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		resetBudget();
		updateStatus(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (!config.enabled) return;
		// The model's reaction to a reminder is not work; counting it would let a small
		// budget re-inject on every reaction forever.
		if (skipNextAssistant && event.message.role === "assistant") {
			skipNextAssistant = false;
			return;
		}
		const chars = assistantOutputChars(event.message, config.countThinking);
		if (chars === 0) return;
		charsSinceInjection += chars;
		if (charsSinceInjection >= config.everyChars) pending = true;
		updateStatus(ctx);
	});

	// Transient injection: append the reminder to the next provider request only.
	pi.on("context", (event, ctx) => {
		if (!config.enabled || !pending || config.mode !== "transient") return;
		consumeBudget();
		updateStatus(ctx);
		return {
			messages: [
				...event.messages,
				{ role: "user" as const, content: reminderText(config.prompt), timestamp: Date.now() },
			],
		};
	});

	// Persistent injection: store the reminder and force one continuation.
	// `event.context` is a preview without this handler's draft, so it reports
	// canContinue=false for a turn that ended on an assistant message. The
	// custom_message draft below turns that into a runnable user message, which is
	// why the continuation is valid regardless of the preview.
	pi.on("turn_end", (event, ctx) => {
		if (!config.enabled || !pending || config.mode !== "persistent") return;
		if (event.outcome !== "completed") return;
		consumeBudget();
		updateStatus(ctx);
		return {
			entries: [
				{
					type: "custom_message" as const,
					customType: "reminder",
					content: reminderText(config.prompt),
					display: config.display,
				},
			],
			continue: true,
		};
	});

	/** One command action. Returns false for an unknown action. */
	const applyAction = (action: string, ctx: ExtensionContext): boolean => {
		switch (action) {
			case "on":
				config = { ...config, enabled: true };
				return true;
			case "off":
				config = { ...config, enabled: false };
				return true;
			case "now":
				pending = true;
				return true;
			case "reset":
				resetBudget();
				return true;
			case "reload":
				reload(ctx);
				return true;
			case "status":
				return true;
			default:
				return false;
		}
	};

	const statusReport = (): string =>
		[
			`pi-reminder: ${config.enabled ? "on" : "off"} (${config.mode}, every ${config.everyChars} chars${
				config.countThinking ? " incl. thinking" : ""
			})`,
			`progress: ${charsSinceInjection}/${config.everyChars}${pending ? " (injection pending)" : ""}`,
			`prompt: ${config.prompt.trim() ? `${config.prompt.length} chars` : "(empty)"}`,
			`config: ${globalFile} | ${projectFile}`,
		].join("\n");

	pi.registerCommand("reminder", {
		description: "pi-reminder: status | now | reset | on | off | reload",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (!applyAction(action, ctx)) {
				ctx.ui.notify("pi-reminder: usage: /reminder [status|now|reset|on|off|reload]", "warning");
				return;
			}
			updateStatus(ctx);
			ctx.ui.notify(statusReport(), "info");
		},
	});
}
