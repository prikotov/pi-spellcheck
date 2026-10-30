/**
 * Интеграционная проверка рендера: настоящий Editor из pi-tui + наше
 * подчёркивание поверх — так же, как это делает SpellEditor в расширении.
 * Проверяем: структуру строк (границы/контент), свойство
 * renderedVisibleLineCount, поведение с курсором (маркеры не ломаются).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const PI_TUI = "/home/dp/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/components/editor.js";
const { Editor } = await import(PI_TUI);
const { underlineMisspelled } = await import("../lib/underline.ts");
const { SpellChecker } = await import("../lib/checker.ts");
const { fileURLToPath } = await import("node:url");

const dict = (n) => fileURLToPath(new URL(`../dictionaries/${n}`, import.meta.url));
const spell = new SpellChecker({
	dictionaries: [
		{ aff: dict("ru.aff"), dic: dict("ru.dic") },
		{ aff: dict("en.aff"), dic: dict("en.dic") },
	],
	userDictPaths: [],
});
spell.load();

function makeEditor(text, focused) {
	const tui = {
		terminal: { rows: 40, columns: 120 },
		requestRender() {},
	};
	const theme = { borderColor: (s) => s, selectList: {} };
	const editor = new Editor(tui, theme);
	editor.focused = focused;
	editor.setText(text);
	return editor;
}

function renderWithUnderline(editor, width) {
	const lines = editor.render(width);
	// Точная копия логики SpellEditor.render
	if (!spell.isReady) return lines;
	const misspelled = new Set(spell.misspelledInText(editor.getText()));
	if (misspelled.size === 0) return lines;
	const visible = editor.renderedVisibleLineCount ?? 0;
	const lastContent = Math.min(1 + visible, lines.length - 1);
	for (let i = 1; i < lastContent; i++) {
		lines[i] = underlineMisspelled(lines[i], misspelled);
	}
	return lines;
}

test("editor structure: borders + renderedVisibleLineCount", () => {
	const editor = makeEditor("скажи превед другу", false);
	const lines = editor.render(80);
	assert.ok(lines.length >= 3, "top border + content + bottom border");
	const visible = editor.renderedVisibleLineCount;
	assert.equal(typeof visible, "number");
	assert.ok(visible >= 1);
	assert.equal(lines.length, visible + 2, "content lines plus two borders");
});

test("underline lands inside editor content, borders untouched", () => {
	const editor = makeEditor("скажи превед другу", false);
	const lines = renderWithUnderline(editor, 80);
	const contentLine = lines[1];
	assert.ok(contentLine.includes("\x1b[4m"), "underline applied to misspelled word");
	assert.ok(!contentLine.includes("4mскажи\x1b"), "correct word not underlined");
	const plain = contentLine.replace(/\x1b\[4m|\x1b\[24m/g, "");
	assert.ok(plain.includes("скажи превед другу"), "text content preserved");
	assert.ok(!lines[0].includes("\x1b[4m"), "top border untouched");
	assert.ok(!lines[lines.length - 1].includes("\x1b[4m"), "bottom border untouched");
});

test("multiline text underlines on every line", () => {
	const editor = makeEditor("превед здесь\nи тут превед тоже\nа тут всё хорошо", false);
	const lines = renderWithUnderline(editor, 80);
	const withUnderline = lines.filter((l) => l.includes("\x1b[4m"));
	assert.equal(withUnderline.length, 2, "both lines with 'превед' underlined");
});

test("focused editor: cursor markers survive underlining", () => {
	const editor = makeEditor("скажи превед другу", true);
	const lines = renderWithUnderline(editor, 80);
	const contentLine = lines[1];
	// Курсор рендерится маркерами pi-tui; они должны остаться на месте.
	if (contentLine.includes("\x1b_pi:")) {
		assert.ok(contentLine.includes("\x1b_pi:c\x07"), "cursor marker intact");
	}
	const stripped = contentLine.replace(/\x1b\[4m|\x1b\[24m/g, "");
	assert.ok(stripped.includes("скажи"), "text preserved with cursor");
});

test("long text: only visible (scrolled) content is processed", () => {
	const filler = Array.from({ length: 30 }, (_, i) => `строка номер ${i} без ошибок вообще`).join("\n");
	const editor = makeEditor(`превед вверху\n${filler}`, false);
	const lines = renderWithUnderline(editor, 80);
	// Первый экран: первая строка контента уже прокручена за верх,
	// подчёркивание не должно падать; количество строк совпадает.
	assert.equal(lines.length, editor.renderedVisibleLineCount + 2);
});
