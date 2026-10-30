/**
 * Replace a whole word in text, preserving everything else.
 * Boundaries include hyphens/apostrophes so "как" is not replaced
 * inside "как-то".
 */

const BOUNDARY = "[\\p{L}\\p{M}'’-]";

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceWholeWord(text: string, from: string, to: string): string {
	const pattern = new RegExp(
		`(?<!${BOUNDARY})${escapeRegExp(from)}(?!${BOUNDARY})`,
		"gu",
	);
	return text.replace(pattern, () => to);
}
