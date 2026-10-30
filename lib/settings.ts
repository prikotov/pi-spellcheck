/**
 * Persistence for spellcheck settings and user dictionaries.
 *
 * Files:
 * - ~/.pi/agent/spellcheck.json     → { "underline": bool, "gate": bool }
 * - ~/.pi/agent/spell-dict.txt      → global user dictionary
 * - <cwd>/.pi/spell-dict.txt        → per-project user dictionary
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface SpellcheckSettings {
	underline: boolean;
	gate: boolean;
}

export const DEFAULT_SETTINGS: SpellcheckSettings = { underline: true, gate: true };

export function agentDir(): string {
	return join(homedir(), ".pi", "agent");
}

export function settingsPath(): string {
	return join(agentDir(), "spellcheck.json");
}

export function globalDictPath(): string {
	return join(agentDir(), "spell-dict.txt");
}

export function projectDictPath(cwd: string): string {
	return join(cwd, ".pi", "spell-dict.txt");
}

export function loadSettings(): SpellcheckSettings {
	const settings = { ...DEFAULT_SETTINGS };
	try {
		if (existsSync(settingsPath())) {
			const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<SpellcheckSettings>;
			if (typeof parsed.underline === "boolean") settings.underline = parsed.underline;
			if (typeof parsed.gate === "boolean") settings.gate = parsed.gate;
		}
	} catch {
		// Corrupt settings: fall back to defaults.
	}
	return settings;
}

export function saveSettings(settings: SpellcheckSettings): void {
	try {
		mkdirSync(dirname(settingsPath()), { recursive: true });
		writeFileSync(settingsPath(), `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
	} catch {
		// Settings are best-effort; the session keeps working without them.
	}
}

/** Append one word to a dictionary file (creating it when missing). */
export function appendWord(dictPath: string, word: string): void {
	try {
		mkdirSync(dirname(dictPath), { recursive: true });
		if (!existsSync(dictPath)) {
			writeFileSync(dictPath, "# pi-spellcheck user dictionary, one word per line\n", "utf8");
		}
		appendFileSync(dictPath, `${word}\n`, "utf8");
	} catch {
		// Best-effort.
	}
}
