import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SpellChecker, matchCase } from "../lib/checker.ts";
import { UNDERLINE_OFF, UNDERLINE_ON, underlineMisspelled } from "../lib/underline.ts";
import { replaceWholeWord } from "../lib/replace.ts";
import { extractWordOccurrences, splitCamelCase } from "../lib/tokenizer.ts";

const here = (name) => fileURLToPath(new URL(`../dictionaries/${name}`, import.meta.url));

function makeChecker() {
	const checker = new SpellChecker({
		dictionaries: [
			{ aff: here("ru.aff"), dic: here("ru.dic") },
			{ aff: here("en.aff"), dic: here("en.dic") },
		],
		userDictPaths: [],
	});
	checker.load();
	return checker;
}

const spell = makeChecker();

test("dictionary load", () => {
	assert.equal(spell.isReady, true);
});

test("russian words", () => {
	assert.equal(spell.isMisspelled("привет"), false);
	assert.equal(spell.isMisspelled("Понедельник"), false);
	assert.equal(spell.isMisspelled("раскладка"), false);
	assert.equal(spell.isMisspelled("превед"), true);
	assert.equal(spell.isMisspelled("папраить"), true);
});

test("caps and case handling", () => {
	assert.equal(spell.isMisspelled("Привет"), false);
	assert.equal(spell.isMisspelled("ПОПРАВИТЬ"), false);
	assert.equal(spell.isMisspelled("Превед"), true);
});

test("english words", () => {
	assert.equal(spell.isMisspelled("hello"), false);
	assert.equal(spell.isMisspelled("teh"), true);
	assert.equal(spell.isMisspelled("recieve"), true);
});

test("acronyms are skipped", () => {
	assert.equal(spell.isMisspelled("API"), false);
	assert.equal(spell.isMisspelled("ТЗ"), false);
	assert.equal(spell.isMisspelled("HTTP"), false);
});

test("camelCase identifiers are skipped", () => {
	assert.equal(spell.isMisspelled("TaskQueue"), false);
	assert.equal(spell.isMisspelled("getUserById"), false);
	assert.equal(splitCamelCase("HTTPServer").join("|"), "HTTP|Server");
});

test("mixed script words are skipped", () => {
	assert.equal(spell.isMisspelled("тестtest"), false);
});

test("hyphenated words check their parts", () => {
	assert.equal(spell.isMisspelled("по-русски"), false);
	assert.equal(spell.isMisspelled("как-нибудь"), false);
});

test("english contractions", () => {
	assert.equal(spell.isMisspelled("don't"), false);
});

test("typing prefixes are not flagged", () => {
	assert.equal(spell.isMisspelled("попра"), false);
	assert.equal(spell.isMisspelled("здра"), false);
});

test("user dictionary", () => {
	assert.equal(spell.isMisspelled("гитхаб"), true);
	spell.addUserWord("гитхаб");
	assert.equal(spell.isMisspelled("гитхаб"), false);
	assert.equal(spell.isMisspelled("Гитхаб"), false);
});

test("misspelledInText returns unique words in order", () => {
	const text = "Папраить файл конфига, превед мир и снова папраить";
	assert.deepEqual(spell.misspelledInText(text), ["Папраить", "конфига", "превед", "папраить"]);
});

test("suggest returns options", () => {
	const suggestions = spell.suggest("превед");
	assert.ok(Array.isArray(suggestions));
});

test("matchCase", () => {
	assert.equal(matchCase("привет", "Превед"), "Привет");
	assert.equal(matchCase("привет", "ПРЕВЕД"), "ПРИВЕТ");
	assert.equal(matchCase("привет", "превед"), "привет");
});

test("replaceWholeWord respects boundaries", () => {
	assert.equal(replaceWholeWord("папраить файл", "папраить", "поправить"), "поправить файл");
	assert.equal(replaceWholeWord("папраить, папраить!", "папраить", "поправить"), "поправить, поправить!");
	assert.equal(replaceWholeWord("как-то папраить", "как", "какой"), "как-то папраить");
});

test("underline plain line", () => {
	const misspelled = new Set(["превед"]);
	const line = "скажи превед миру";
	const result = underlineMisspelled(line, misspelled);
	assert.ok(result.includes(UNDERLINE_ON + "превед" + UNDERLINE_OFF));
	assert.equal(result.replace(/\x1b\[[0-9;:]*m/g, ""), line);
});

test("underline preserves escape sequences", () => {
	const misspelled = new Set(["превед"]);
	const line = "\x1b[38;2;233;137;115mскажи\x1b[0m превед \x1b_pi:fc\x07т\x1b_pi:/fc\x07ест";
	const result = underlineMisspelled(line, misspelled);
	assert.ok(result.includes("\x1b[38;2;233;137;115mскажи\x1b[0m"));
	assert.ok(result.includes("\x1b_pi:fc\x07"));
	assert.ok(result.includes(UNDERLINE_ON + "превед" + UNDERLINE_OFF));
	// Слово "тест" разбито фейковым курсором, его не трогаем.
	assert.ok(result.includes("\x1b_pi:fc\x07т\x1b_pi:/fc\x07ест"));
});

test("underline red dashed codes present", () => {
	assert.ok(UNDERLINE_ON.includes("\x1b[58;2;"), "underline color (SGR 58)");
	assert.ok(UNDERLINE_ON.includes("\x1b[4:5m"), "dashed underline (SGR 4:5)");
	assert.ok(UNDERLINE_ON.includes("\x1b[4m"), "plain underline fallback (SGR 4)");
	assert.ok(UNDERLINE_ON.indexOf("\x1b[4m") < UNDERLINE_ON.indexOf("\x1b[4:5m"), "styled underline must come after plain (last wins)");
	assert.ok(UNDERLINE_OFF.includes("\x1b[59m"), "underline color reset (SGR 59)");
});

test("underline does not flag m inside escape sequences", () => {
	const line = "\x1b[38;2;233;137;115mцвет\x1b[0m";
	const result = underlineMisspelled(line, new Set(["цвет"]));
	assert.ok(result.includes(UNDERLINE_ON + "цвет" + UNDERLINE_OFF));
	// No underline inserted inside the sequence itself.
	assert.ok(!result.includes("115;" + UNDERLINE_ON));
});

test("tokenizer extracts words from noisy text", () => {
	const words = extractWordOccurrences("поправить src/config.json — файл /tmp/x1 API_версия").map((w) => w.word);
	assert.deepEqual(words, ["поправить", "src", "config", "json", "файл", "tmp", "API", "версия"]);
});
