/**
 * pi-spellcheck — проверка орфографии в редакторе pi (ru + en).
 *
 * - Живое подчёркивание опечаток прямо в редакторе ввода.
 * - ctrl+; — диалог исправлений: варианты, «пропустить», «добавить в словарь».
 * - Проверка перед отправкой (gate): если в сообщении есть опечатки, pi
 *   предложит исправить их до того, как сообщение уйдёт модели.
 * - Личные словари: ~/.pi/agent/spell-dict.txt (глобальный) и
 *   .pi/spell-dict.txt (проектный).
 * - /spell — управление: on/off, gate on/off, add <слово>, reload.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { SpellChecker, matchCase } from "../lib/checker.ts";
import { underlineMisspelled } from "../lib/underline.ts";
import { replaceWholeWord } from "../lib/replace.ts";
import {
	appendWord,
	globalDictPath,
	loadSettings,
	projectDictPath,
	saveSettings,
	type SpellcheckSettings,
} from "../lib/settings.ts";

const MAX_CHECK_LENGTH = 100_000; // огромные вставки не проверяем
const MIN_GATE_LENGTH = 8; // короткие сообщения до gate не доводим

interface RuntimeState {
	underline: boolean;
	gate: boolean;
}

function dictionaryPaths(): { aff: string; dic: string }[] {
	const here = (name: string) => fileURLToPath(new URL(`../dictionaries/${name}`, import.meta.url));
	return [
		{ aff: here("ru.aff"), dic: here("ru.dic") },
		{ aff: here("en.aff"), dic: here("en.dic") },
	];
}

class SpellEditor extends CustomEditor {
	private lastCheckedText: string | null = null;
	private misspelled = new Set<string>();

	// ВАЖНО: имена полей/параметров не должны перекрывать поля базового
	// Editor (state, history, pastes…) — при define-for-class-fields
	// затенение обнуляет состояние редактора.
	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		kb: ConstructorParameters<typeof CustomEditor>[2],
		private readonly spell: SpellChecker | undefined,
		private readonly runtime: RuntimeState,
	) {
		super(tui, theme, kb);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (!this.runtime.underline || !this.spell?.isReady) return lines;
		const text = this.getText();
		if (text.length > MAX_CHECK_LENGTH) return lines;
		if (text !== this.lastCheckedText) {
			this.lastCheckedText = text;
			this.misspelled = new Set(this.spell.misspelledInText(text));
		}
		if (this.misspelled.size === 0) return lines;
		// Lines 1..renderedVisibleLineCount are editor content; 0 and the last
		// line are borders, trailing lines belong to autocomplete.
		const visible = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount ?? 0;
		const lastContent = Math.min(1 + visible, lines.length - 1);
		for (let i = 1; i < lastContent; i++) {
			lines[i] = underlineMisspelled(lines[i], this.misspelled);
		}
		return lines;
	}
}

/** Interactive fix dialog. Returns the corrected text (or the original). */
async function runFixDialog(
	original: string,
	spell: SpellChecker,
	ctx: ExtensionContext,
): Promise<string> {
	let current = original;
	const skipped = new Set<string>();
	for (;;) {
		const words = spell.misspelledInText(current).filter((word) => !skipped.has(word));
		if (words.length === 0) break;
		const word = words[0];
		const suggestions = spell.suggest(word).map((suggestion) => matchCase(suggestion, word));
		const SKIP = "Пропустить";
		const ADD_GLOBAL = "В словарь (глобальный)";
		const ADD_PROJECT = "В словарь (проект)";
		const DONE = "Готово";
		const choice = await ctx.ui.select(
			`«${word}» — предложено ${words.length === 1 ? "1 исправление" : `исправлений осталось: ${words.length}`}`,
			[...suggestions, SKIP, ADD_GLOBAL, ADD_PROJECT, DONE],
		);
		if (choice === undefined || choice === DONE) break; // Esc — завершить
		if (choice === ADD_GLOBAL) {
			appendWord(globalDictPath(), word.toLowerCase());
			spell.addUserWord(word);
			continue;
		}
		if (choice === ADD_PROJECT) {
			appendWord(projectDictPath(ctx.cwd), word.toLowerCase());
			spell.addUserWord(word);
			continue;
		}
		if (choice === SKIP) {
			skipped.add(word);
			continue;
		}
		current = replaceWholeWord(current, word, choice);
	}
	return current;
}

function describeWords(words: string[]): string {
	const shown = words.slice(0, 8);
	const rest = words.length - shown.length;
	return shown.join(", ") + (rest > 0 ? ` … +${rest}` : "");
}

export default function (pi: ExtensionAPI) {
	let checker: SpellChecker | undefined;
	const state: RuntimeState = { underline: true, gate: true };

	pi.on("session_start", async (_event, ctx) => {
		const settings: SpellcheckSettings = loadSettings();
		state.underline = settings.underline;
		state.gate = settings.gate;

		checker = new SpellChecker({
			dictionaries: dictionaryPaths(),
			userDictPaths: [globalDictPath(), projectDictPath(ctx.cwd)],
		});
		// Дictionaries take ~2s to load; keep them off the startup path.
		setTimeout(() => {
			checker?.load();
			if (checker && !checker.isReady) {
				const message = "pi-spellcheck: не удалось загрузить словари";
				if (ctx.hasUI) {
					ctx.ui.notify(message, "warning");
				} else {
					console.error(message);
				}
			}
		}, 100);

		if (ctx.hasUI) {
			ctx.ui.setEditorComponent(
				(tui, theme, kb) => new SpellEditor(tui, theme, kb, checker, state),
			);
		}
	});

	// ctrl+; — проверить и исправить текст в редакторе.
	pi.registerShortcut("ctrl+;", {
		description: "Проверить орфографию в редакторе",
		handler: async (ctx) => {
			if (!checker?.isReady || !ctx.hasUI) return;
			const text = ctx.ui.getEditorText();
			if (!text.trim()) {
				ctx.ui.notify("Редактор пуст", "info");
				return;
			}
			const corrected = await runFixDialog(text, checker, ctx);
			if (corrected !== text) {
				ctx.ui.setEditorText(corrected);
				ctx.ui.notify("Исправления применены", "info");
			}
		},
	});

	// Gate: перед отправкой предложить исправить опечатки.
	pi.on("input", async (event, ctx) => {
		if (!state.gate || !checker?.isReady) return { action: "continue" };
		if (event.source !== "interactive" || !ctx.hasUI) return { action: "continue" };
		if (event.text.startsWith("/") || event.text.length < MIN_GATE_LENGTH) {
			return { action: "continue" };
		}
		if (event.text.length > MAX_CHECK_LENGTH) return { action: "continue" };
		const misspelled = checker.misspelledInText(event.text);
		if (misspelled.length === 0) return { action: "continue" };

		const choice = await ctx.ui.select(
			`Возможные опечатки: ${describeWords(misspelled)}`,
			["Отправить как есть", "Исправить опечатки", "Вернуть в редактор"],
		);
		if (choice === undefined) {
			// Esc — не отправлять, вернуть текст в редактор.
			ctx.ui.setEditorText(event.text);
			return { action: "handled" };
		}
		if (choice === "Отправить как есть") return { action: "continue" };
		if (choice === "Вернуть в редактор") {
			ctx.ui.setEditorText(event.text);
			return { action: "handled" };
		}
		const corrected = await runFixDialog(event.text, checker, ctx);
		if (corrected !== event.text) return { action: "transform", text: corrected };
		return { action: "continue" };
	});

	// /spell — управление.
	pi.registerCommand("spell", {
		description: "Проверка орфографии: on/off, gate on/off, add <слово>, reload",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0];

			if (!sub) {
				ctx.ui.notify(
					`pi-spellcheck: подчёркивание ${state.underline ? "вкл" : "выкл"}, проверка перед отправкой ${state.gate ? "вкл" : "выкл"}, словари ${checker?.isReady ? "загружены" : "не загружены"}`,
					"info",
				);
				return;
			}

			if (sub === "on" || sub === "off") {
				state.underline = sub === "on";
				saveSettings({ underline: state.underline, gate: state.gate });
				ctx.ui.notify(`Подчёркивание: ${state.underline ? "вкл" : "выкл"}`, "info");
				return;
			}

			if (sub === "gate") {
				const value = parts[1];
				state.gate = value === undefined ? !state.gate : value === "on";
				saveSettings({ underline: state.underline, gate: state.gate });
				ctx.ui.notify(
					`Проверка перед отправкой: ${state.gate ? "вкл" : "выкл"}`,
					"info",
				);
				return;
			}

			if (sub === "add" && parts.length > 1) {
				const word = parts.slice(1).join(" ").toLowerCase();
				appendWord(globalDictPath(), word);
				checker?.addUserWord(word);
				ctx.ui.notify(`«${word}» добавлено в глобальный словарь`, "info");
				return;
			}

			if (sub === "reload") {
				checker?.reload();
				ctx.ui.notify(
					checker?.isReady ? "Словари перезагружены" : "Не удалось перезагрузить словари",
					checker?.isReady ? "info" : "warning",
				);
				return;
			}

			ctx.ui.notify(
				"Использование: /spell [on|off] | gate [on|off] | add <слово> | reload",
				"info",
			);
		},
	});
}
