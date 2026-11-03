/**
 * Word tokenizer for spell checking.
 *
 * Extracts "words" from arbitrary prompt text: sequences of letters
 * (Cyrillic, Latin, any unicode letters/marks), with intra-word
 * apostrophes and hyphens kept ("don't", "как-то").
 *
 * Non-prose regions (URLs, emails, file paths, bare domains and
 * filenames like package.json) are skipped entirely: словарь не для
 * них, а короткие фрагменты внутри («com», «usr») дают ложные
 * срабатывания. Всё остальное (код, цифры, markdown) естественно
 * распадается на короткие фрагменты, которые отсекаются эвристиками.
 */

const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;

/** Внутренние регионы, которые не проверяем: в порядке приоритета. */
const SKIP_RES: RegExp[] = [
	// URL: https://…, www.что-угодно
	/(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+/giu,
	// Email: user@example.com (включая точки-плюсы в локальной части)
	/[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/giu,
	// Пути: /usr/bin, src/config.json, ./lib/x.ts, ~/проект/файл, C:\temp\файл.txt
	/(?:^|[\s(<\[{"'`«»])(?:[a-z]:)?(?:~|\.{1,2})?(?:[\p{L}\p{N}_.~-]+)?(?:[\\/][\p{L}\p{N}@%+_=.:~\\/-]+)+/giu,
	// Домены и имена файлов: github.com, ru.js, README.md, spell-dict.txt
	/\b[\p{L}\p{N}][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)+\b/giu,
	// Упоминания: @username
	/(?:^|[\s(<\[{"'`«»])@[\p{L}\p{N}_]+/giu,
];

export interface WordOccurrence {
	/** The word as it appears in the text. */
	word: string;
	/** Offset in the source text (of the trimmed word). */
	index: number;
}

/** Непересекающиеся диапазоны символов [from, to), которые не проверяем. */
function skipRanges(text: string): [number, number][] {
	const ranges: [number, number][] = [];
	for (const re of SKIP_RES) {
		for (const match of text.matchAll(re)) {
			const start = match.index ?? 0;
			const end = start + match[0].length;
			if (end <= start) continue;
			ranges.push([start, end]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	// Схлопываем пересечения: если URL попал в путь — это один регион.
	const merged: [number, number][] = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1]) {
			last[1] = Math.max(last[1], range[1]);
		} else {
			merged.push([...range] as [number, number]);
		}
	}
	return merged;
}

function inRanges(ranges: [number, number][], index: number): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [from, to] = ranges[mid];
		if (index < from) hi = mid - 1;
		else if (index >= to) lo = mid + 1;
		else return true;
	}
	return false;
}

/** Extract word occurrences in order of appearance. */
export function extractWordOccurrences(text: string): WordOccurrence[] {
	const result: WordOccurrence[] = [];
	const ranges = skipRanges(text);
	for (const match of text.matchAll(WORD_RE)) {
		let word = match[0];
		let index = match.index ?? 0;
		if (inRanges(ranges, index)) continue;
		// Trim edge hyphens/apostrophes ("—привет", "слово'-").
		const trimmed = word.replace(/^[-'’]+|[-'’]+$/g, "");
		if (trimmed.length !== word.length) {
			index += word.indexOf(trimmed);
			word = trimmed;
		}
		if (word.length < 2) continue;
		result.push({ word, index });
	}
	return result;
}

/** Unique words in order of first occurrence. */
export function uniqueWords(text: string): string[] {
	const seen = new Set<string>();
	const words: string[] = [];
	for (const { word } of extractWordOccurrences(text)) {
		if (seen.has(word)) continue;
		seen.add(word);
		words.push(word);
	}
	return words;
}

export const HAS_CYRILLIC = /\p{Script=Cyrillic}/u;
export const HAS_LATIN = /\p{Script=Latin}/u;

/** True when a word mixes Cyrillic and Latin letters (e.g. "тестТест"). */
export function isMixedScript(word: string): boolean {
	return HAS_CYRILLIC.test(word) && HAS_LATIN.test(word);
}

/**
 * Split a camelCase / PascalCase word into logical parts.
 * "TaskQueue" -> ["Task", "Queue"], "HTTPServer" -> ["HTTP", "Server"].
 */
export function splitCamelCase(word: string): string[] {
	return word
		.replace(/([\p{Ll}\p{M}])(\p{Lu})/gu, "$1 $2")
		.replace(/(\p{Lu})(\p{Lu}[\p{Ll}\p{M}])/gu, "$1 $2")
		.split(" ");
}

/** True when the whole word is uppercase letters (acronyms, "ВАЖНО"). */
export function isAllCaps(word: string): boolean {
	return /^[\p{Lu}]+$/u.test(word);
}
