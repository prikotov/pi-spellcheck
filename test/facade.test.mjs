import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { SpellChecker } from "../lib/checker.ts";

const dict = (n) => fileURLToPath(new URL(`../dictionaries/${n}`, import.meta.url));

test("async facade: worker check, suggest, addWord", async () => {
	const spell = new SpellChecker({
		dictionaries: [
			{ aff: dict("ru.aff"), dic: dict("ru.dic") },
			{ aff: dict("en.aff"), dic: dict("en.dic") },
		],
		userDictPaths: [],
	});
	try {
		spell.warmup();
		// Рано или поздно воркер загрузится (~2с); ждём isReady.
		const start = Date.now();
		while (!spell.isReady && Date.now() - start < 15000) {
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.equal(spell.isReady, true, "worker became ready");

		const words = await spell.checkText("Папраить файл конфига, превед мир");
		assert.deepEqual(words, ["Папраить", "конфига", "превед"]);

		// Кеш для синхронного рендера
		const set = spell.getSet("Папраить файл конфига, превед мир");
		assert.ok(set instanceof Set && set.size === 3);

		const suggestions = await spell.suggest("превед");
		assert.ok(Array.isArray(suggestions));

		spell.addUserWord("гитхаб");
		const words2 = await spell.checkText("гитхаб превед");
		assert.deepEqual(words2, ["превед"]);
	} finally {
		spell.dispose();
	}
});
