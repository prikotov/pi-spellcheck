/**
 * ANSI-aware underlining of misspelled words in rendered TUI lines.
 *
 * The editor renders plain text plus escape sequences (SGR colors, fake
 * cursor markers). We split each line into escape runs and printable runs,
 * underline misspelled words inside printable runs only, and never touch
 * the escape sequences — so cursor markers, colors and padding stay intact.
 */

/**
 * Красное пунктирное подчёркивание опечаток, как в браузерах.
 *
 * SGR 58 задаёт цвет линии подчёркивания (#ff4040); на терминалах без
 * поддержки он игнорируется и линия будет цветом текста. SGR 4:5 —
 * пунктирная линия (Ghostty, kitty, wezterm, свежие VTE); ОБЫЧНЫЙ SGR 4
 * ставим ПЕРЕД стилевым: где 4:5 не поддержан, он игнорируется и остаётся
 * прямое подчёркивание, а где поддержан — пунктир побеждает (last wins).
 */
export const UNDERLINE_ON = "\x1b[58;2;255;64;64m\x1b[4m\x1b[4:5m";
export const UNDERLINE_OFF = "\x1b[24m\x1b[59m";

const ESC = "\x1b";

/**
 * Copy one escape sequence from the line starting at `i`.
 * Handles CSI (`ESC [ ... final`), APC pi markers (`ESC _pi:... BEL`),
 * other ESC-prefixed sequences, and lone BEL.
 * Returns the raw sequence (or a single char as fallback).
 */
function takeEscape(line: string, i: number): string {
	const char = line[i];
	if (char !== ESC) {
		return char;
	}
	const next = line[i + 1];
	if (next === "[") {
		// CSI: parameters and intermediates end with a final byte 0x40–0x7E.
		let j = i + 2;
		while (j < line.length) {
			const code = line.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) {
				return line.slice(i, j + 1);
			}
			j++;
		}
		return line.slice(i);
	}
	if (next === "_") {
		// APC sequence, terminated by BEL (pi-tui cursor markers).
		const end = line.indexOf("\x07", i);
		if (end !== -1) return line.slice(i, end + 1);
		return line.slice(i);
	}
	if (next === "]") {
		// OSC sequence, terminated by BEL.
		const end = line.indexOf("\x07", i);
		if (end !== -1) return line.slice(i, end + 1);
		return line.slice(i);
	}
	return line.slice(i, i + 2);
}

const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;

/** Underline every misspelled word in one rendered line. */
export function underlineMisspelled(line: string, misspelled: Set<string>): string {
	if (misspelled.size === 0) return line;
	if (!line.includes(ESC) && !line.includes("\x07")) {
		return underlinePlainText(line, misspelled);
	}
	let result = "";
	let runStart = 0;
	let i = 0;
	while (i < line.length) {
		if (line[i] === ESC || line[i] === "\x07") {
			result += underlinePlainText(line.slice(runStart, i), misspelled);
			const sequence = takeEscape(line, i);
			result += sequence;
			i += sequence.length;
			runStart = i;
		} else {
			i++;
		}
	}
	result += underlinePlainText(line.slice(runStart), misspelled);
	return result;
}

function underlinePlainText(text: string, misspelled: Set<string>): string {
	if (!text) return text;
	return text.replace(WORD_RE, (word) => {
		if (misspelled.has(word) || misspelled.has(word.replace(/^[-'’]+|[-'’]+$/g, ""))) {
			return UNDERLINE_ON + word + UNDERLINE_OFF;
		}
		return word;
	});
}
