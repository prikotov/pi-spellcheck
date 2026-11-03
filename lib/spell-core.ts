/**
 * Spell checker built on a vendored copy of nspell (hunspell-compatible)
 * with Russian and English dictionaries, plus user dictionaries.
 *
 * Design notes:
 * - nspell cannot merge dictionaries with different .aff files (its
 *   dictionary() method ignores the second aff argument and parses new
 *   words with the constructor's affix rules). So each language gets its
 *   own NSpell instance, and a word is correct if ANY instance accepts it.
 * - Dictionary load is slow (~2s), so it happens lazily/off the startup path.
 *   Until loaded, everything is considered correctly spelled.
 * - Results are cached per raw word; the cache doubles as the hot path for
 *   live editor underlining.
 * - Heuristics suppress common false positives: camelCase identifiers,
 *   acronyms, mixed-script words, hyphenations, words being typed that are
 *   a prefix of a dictionary word.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
	extractWordOccurrences,
	isAllCaps,
	isMixedScript,
	splitCamelCase,
	HAS_CYRILLIC,
} from "./tokenizer.ts";

// nspell is CommonJS; createRequire keeps this file importable both as ESM
// (tests) and through jiti (pi extensions).
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NSpell: NSpellConstructor = require("../vendor/nspell/lib/index.js");

interface NSpellInstance {
	correct(word: string): boolean;
	suggest(word: string): string[];
	dictionary(dic: Buffer | string, aff?: Buffer | string): boolean;
	add(word: string, model?: string): boolean;
}

interface NSpellConstructor {
	new (aff: Buffer | string, dic?: Buffer | string): NSpellInstance;
}

export interface DictionarySpec {
	aff: string;
	dic: string;
	/** Language hint used to route suggest() by word script. */
	lang?: "ru" | "en";
}

export interface SpellCheckerOptions {
	dictionaries: DictionarySpec[];
	/** One word per line, `#` comments allowed. */
	userDictPaths: string[];
	/** Bundled extra word lists (e.g. tech.txt), same format as user dicts. */
	wordLists?: string[];
}

const MAX_CACHE_SIZE = 20_000;
const ACRONYM_MAX_LEN = 5;

export class SpellCore {
	/** One nspell instance per language dictionary. */
	private spells: NSpellInstance[] = [];
	private loadFailed = false;
	/** Lowercase dictionary stems, indexed by first letter (for prefix checks). */
	private stemsByLetter = new Map<string, Set<string>>();
	private userWords = new Set<string>();
	private correctCache = new Map<string, boolean>();
	private prefixCache = new Map<string, boolean>();
	private suggestCache = new Map<string, string[]>();

	readonly options: SpellCheckerOptions;

	constructor(options: SpellCheckerOptions) {
		this.options = options;
	}

	/** Load dictionaries. Blocking (~2s). Safe to call again via reload(). */
	load(): void {
		if (this.spells.length > 0 || this.loadFailed) return;
		try {
			for (const dict of this.options.dictionaries) {
				// Отдельный инстанс на язык: dictionary() у nspell игнорирует
				// второй аргумент (.aff) и ломает аффиксы первого словаря.
				this.spells.push(new NSpell(readFileSync(dict.aff), readFileSync(dict.dic)));
				this.indexStems(readFileSync(dict.dic, "utf8"));
			}
			for (const path of [...this.options.wordLists ?? [], ...this.options.userDictPaths]) {
				this.loadUserDict(path);
			}
		} catch {
			this.loadFailed = true;
			this.spells = [];
		}
	}

	get isReady(): boolean {
		return this.spells.length > 0;
	}

	reload(): void {
		this.spells = [];
		this.loadFailed = false;
		this.stemsByLetter = new Map();
		this.userWords = new Set();
		this.clearCaches();
		this.load();
	}

	private clearCaches(): void {
		this.correctCache.clear();
		this.prefixCache.clear();
		this.suggestCache.clear();
	}

	/** Add a word to an in-memory user set (persistence is the caller's job). */
	addUserWord(word: string): void {
		const normalized = word.trim().toLowerCase();
		if (!normalized) return;
		this.userWords.add(normalized);
		this.correctCache.clear();
	}

	private loadUserDict(path: string): void {
		if (!existsSync(path)) return;
		const content = readFileSync(path, "utf8");
		for (const line of content.split("\n")) {
			const word = line.trim();
			if (!word || word.startsWith("#")) continue;
			this.userWords.add(word.toLowerCase());
		}
	}

	/** Index dictionary stems (before "/flag") by first letter. */
	private indexStems(dic: string): void {
		const lines = dic.split("\n");
		for (let i = 1; i < lines.length; i++) {
			const stem = lines[i].split("/")[0].trim().toLowerCase();
			if (stem.length < 2) continue;
			const letter = stem[0];
			let set = this.stemsByLetter.get(letter);
			if (!set) {
				set = new Set();
				this.stemsByLetter.set(letter, set);
			}
			set.add(stem);
		}
	}

	private isCorrect(word: string): boolean {
		if (this.userWords.has(word.toLowerCase())) return true;
		if (this.spells.length === 0) return true;
		// Слово считается правильным, если его приняла любая языковая
		// морфология (латиница может встретиться и в русском тексте и наоборот).
		return this.spells.some((spell) => spell.correct(word));
	}

	/** True when the word is a prefix of some known dictionary stem. */
	private isKnownPrefix(lower: string): boolean {
		if (lower.length < 3) return false;
		const cached = this.prefixCache.get(lower);
		if (cached !== undefined) return cached;
		let result = false;
		const stems = this.stemsByLetter.get(lower[0]);
		if (stems) {
			for (const stem of stems) {
				if (stem.startsWith(lower)) {
					result = true;
					break;
				}
			}
		}
		this.prefixCache.set(lower, result);
		return result;
	}

	/** Heuristic + dictionary check for one word. True = misspelled. */
	isMisspelled(raw: string): boolean {
		if (this.spells.length === 0) return false;
		const cached = this.correctCache.get(raw);
		if (cached !== undefined) return cached;
		const result = this.computeMisspelled(raw);
		if (this.correctCache.size >= MAX_CACHE_SIZE) this.correctCache.clear();
		this.correctCache.set(raw, result);
		return result;
	}

	private computeMisspelled(raw: string): boolean {
		const word = raw.replace(/^[-'’]+|[-'’]+$/g, "");
		if (word.length < 2) return false;
		if (isMixedScript(word)) return false;
		if (word.includes("-")) {
			const parts = word.split("-");
			// "по-русски": correct when every meaningful part is correct.
			return parts.some((part) => part.length >= 2 && this.simpleMisspelled(part));
		}
		return this.simpleMisspelled(word);
	}

	private simpleMisspelled(word: string): boolean {
		if (word.length < 2) return false;
		// camelCase identifiers: "TaskQueue", "getUserById".
		if (/[a-z]/.test(word) && /[A-Z]/.test(word)) {
			const parts = splitCamelCase(word);
			if (parts.length > 1 && parts.every((part) => !this.simpleMisspelled(part))) {
				return false;
			}
		}
		// Short acronyms: "API", "ТЗ", "HTTP".
		if (isAllCaps(word) && word.length <= ACRONYM_MAX_LEN) return false;
		if (this.isCorrect(word)) return false;
		const lower = word.toLowerCase();
		if (this.isCorrect(lower)) return false;
		// A Cyrillic word being typed is often a prefix of a valid word.
		// (Not applied to Latin: short garbage like "teh" is a prefix of
		// real stems — "tehran" — and must stay flagged.)
		if (HAS_CYRILLIC.test(word) && this.isKnownPrefix(lower)) return false;
		// "don't", "it's" — check the segments around the apostrophe.
		if (/['’]/.test(word)) {
			const segments = word.split(/['’]/).filter((segment) => segment.length >= 2);
			if (segments.length > 0 && segments.every((segment) => !this.simpleMisspelled(segment))) {
				return false;
			}
		}
		return true;
	}

	/** Spelling suggestions for a word (best effort, hunspell-like). */
	suggest(word: string): string[] {
		if (this.spells.length === 0) return [];
		const key = word.toLowerCase();
		const cached = this.suggestCache.get(key);
		if (cached) return cached;
		let suggestions: string[] = [];
		try {
			// Сначала морфология языка слова, иначе чужие словари дают мусор:
			// латиница → en, кириллица → ru.
			const lang: "ru" | "en" = HAS_CYRILLIC.test(key) ? "ru" : "en";
			const primary = this.spellsOf(lang);
			const secondary = this.spells.filter((spell) => !primary.includes(spell));
			for (const spell of [...primary, ...secondary]) {
				if (suggestions.length >= 8) break;
				for (const item of spell.suggest(key)) {
					if (suggestions.length >= 8) break;
					if (!suggestions.includes(item)) suggestions.push(item);
				}
			}
		} catch {
			suggestions = [];
		}
		this.suggestCache.set(key, suggestions);
		return suggestions;
	}

	private spellsOf(lang: "ru" | "en"): NSpellInstance[] {
		const result: NSpellInstance[] = [];
		this.options.dictionaries.forEach((dict, i) => {
			if ((dict.lang ?? "en") === lang) result.push(this.spells[i]);
		});
		return result;
	}

	/** All misspelled words in the text, in order of first occurrence. */
	misspelledInText(text: string): string[] {
		if (this.spells.length === 0) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const { word } of extractWordOccurrences(text)) {
			if (seen.has(word)) continue;
			if (this.isMisspelled(word)) {
				seen.add(word);
				result.push(word);
			}
		}
		return result;
	}
}

/** Match the letter case of `original` onto `suggestion`. */
export function matchCase(suggestion: string, original: string): string {
	if (!suggestion) return suggestion;
	if (/^[\p{Lu}]{2,}$/u.test(original)) return suggestion.toUpperCase();
	if (/^[\p{Lu}]/u.test(original)) {
		return suggestion[0].toUpperCase() + suggestion.slice(1);
	}
	return suggestion;
}
