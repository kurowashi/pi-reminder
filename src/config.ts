/**
 * Config discovery and resolution for pi-reminder.
 *
 * Files are merged nearest-last: the global config at
 * `~/.pi/agent/reminder.json` (or `$PI_CODING_AGENT_DIR/reminder.json`) is read
 * first and the project config at `<cwd>/.pi/reminder.json` overrides it.
 * Project configs are ignored when the project is not trusted.
 *
 * Unknown keys are ignored and invalid values fall back to the default with a
 * warning instead of throwing, so a broken config never breaks a session.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CONFIG_FILE_NAME = "reminder.json";

export type InjectMode = "transient" | "persistent";

export interface ReminderConfig {
	/** Master switch. When false the extension only shows status. */
	enabled: boolean;
	/** Assistant output characters between injections. */
	everyChars: number;
	/** Count thinking blocks in addition to visible text. */
	countThinking: boolean;
	/**
	 * transient: append the reminder to the next model request only.
	 * persistent: store it in the session at turn end and continue the run.
	 */
	mode: InjectMode;
	/** Render persistent reminders in the transcript. Ignored when transient. */
	display: boolean;
	/** Text injected once the character budget is exhausted. */
	prompt: string;
}

export const DEFAULT_CONFIG: ReminderConfig = {
	enabled: true,
	everyChars: 20_000,
	countThinking: true,
	mode: "transient",
	display: false,
	prompt: "",
};

export interface LoadedReminderConfig {
	config: ReminderConfig;
	warnings: string[];
	globalFile: string;
	projectFile: string;
}

export function agentDir(): string {
	const override = process.env["PI_CODING_AGENT_DIR"]?.trim();
	return override && override.length > 0 ? override : path.join(os.homedir(), ".pi", "agent");
}

export function globalConfigPath(): string {
	return path.join(agentDir(), CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", CONFIG_FILE_NAME);
}

function readConfigFile(file: string): { value?: Record<string, unknown>; warning?: string } {
	if (!fs.existsSync(file)) return {};
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { warning: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { warning: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { warning: `${file} must contain a JSON object` };
	}
	return { value: parsed as Record<string, unknown> };
}

function booleanOr(value: unknown, key: string, fallback: boolean, warnings: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`reminder: ${key} must be a boolean; using ${fallback}`);
	return fallback;
}

function positiveIntOr(value: unknown, key: string, fallback: number, warnings: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	warnings.push(`reminder: ${key} must be a positive number; using ${fallback}`);
	return fallback;
}

function stringOr(value: unknown, key: string, fallback: string, warnings: string[]): string {
	if (value === undefined) return fallback;
	if (typeof value === "string") return value;
	warnings.push(`reminder: ${key} must be a string; using ${fallback}`);
	return fallback;
}

/** Validate raw configs (lowest precedence first) into a complete config. */
export function resolveConfig(raws: Record<string, unknown>[], warnings: string[]): ReminderConfig {
	const raw: Record<string, unknown> = Object.assign({}, ...raws);
	const rawMode = raw["mode"];
	const mode = rawMode === undefined || rawMode === "transient" || rawMode === "persistent" ? rawMode : undefined;
	if (rawMode !== undefined && mode === undefined) {
		warnings.push(`reminder: mode must be "transient" or "persistent"; using ${DEFAULT_CONFIG.mode}`);
	}
	return {
		enabled: booleanOr(raw["enabled"], "enabled", DEFAULT_CONFIG.enabled, warnings),
		everyChars: positiveIntOr(raw["everyChars"], "everyChars", DEFAULT_CONFIG.everyChars, warnings),
		countThinking: booleanOr(raw["countThinking"], "countThinking", DEFAULT_CONFIG.countThinking, warnings),
		mode: (mode as InjectMode | undefined) ?? DEFAULT_CONFIG.mode,
		display: booleanOr(raw["display"], "display", DEFAULT_CONFIG.display, warnings),
		prompt: stringOr(raw["prompt"], "prompt", DEFAULT_CONFIG.prompt, warnings),
	};
}

export function loadConfig(cwd: string, trusted: boolean): LoadedReminderConfig {
	const globalFile = globalConfigPath();
	const projectFile = projectConfigPath(cwd);
	const warnings: string[] = [];
	const raws: Record<string, unknown>[] = [];

	const globalRead = readConfigFile(globalFile);
	if (globalRead.warning) warnings.push(globalRead.warning);
	if (globalRead.value) raws.push(globalRead.value);

	if (fs.existsSync(projectFile)) {
		if (trusted) {
			const projectRead = readConfigFile(projectFile);
			if (projectRead.warning) warnings.push(projectRead.warning);
			if (projectRead.value) raws.push(projectRead.value);
		} else {
			warnings.push(`ignoring ${projectFile}: project is not trusted (use /trust to enable project config)`);
		}
	}

	return { config: resolveConfig(raws, warnings), warnings, globalFile, projectFile };
}
