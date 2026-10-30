/**
 * Word tokenizer for spell checking.
 *
 * Extracts "words" from arbitrary prompt text: sequences of letters
 * (Cyrillic, Latin, any unicode letters/marks), with intra-word
 * apostrophes and hyphens kept ("don't", "как-то").
 *
 * Everything else (paths, URLs, code, digits, markdown) naturally falls
 * apart into short fragments that the checker filters heuristically.
 */

const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;

export interface WordOccurrence {
	/** The word as it appears in the text. */
	word: string;
	/** Offset in the source text (of the trimmed word). */
	index: number;
}

/** Extract word occurrences in order of appearance. */
export function extractWordOccurrences(text: string): WordOccurrence[] {
	const result: WordOccurrence[] = [];
	for (const match of text.matchAll(WORD_RE)) {
		let word = match[0];
		let index = match.index ?? 0;
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
