/**
 * Worker pi-spellcheck: держит словари и проверки подальше от главного
 * потока pi, чтобы загрузка словарей (~2с CPU) не блокировала ввод.
 *
 * Протокол (workerData):
 *   { dictionaries: [{aff, dic}], userDictPaths: string[] }
 * Сообщения (id > 0 — запрос/ответ, id === -1 — ready-сигнал):
 *   → { id, type: "check",   text }        ← { id, payload: string[] }
 *   → { id, type: "suggest", word }        ← { id, payload: string[] }
 *   → { id, type: "addWord", word }        ← { id, payload: true }
 *   → { id, type: "reload" }               ← { id, payload: true }
 *   ← { id: -1 }                           (словари загружены)
 */

import { parentPort, workerData } from "node:worker_threads";
import { SpellCore } from "../lib/spell-core.ts";

const { dictionaries, userDictPaths } = workerData;

// Загрузка блокирует только этот поток.
const core = new SpellCore({ dictionaries, userDictPaths });
core.load();

const port = parentPort;

function respond(id, payload) {
	port.postMessage({ id, payload });
}

port.on("message", (message) => {
	const { id, type } = message;
	try {
		if (type === "check") {
			respond(id, core.misspelledInText(message.text));
		} else if (type === "suggest") {
			respond(id, core.suggest(message.word));
		} else if (type === "addWord") {
			core.addUserWord(message.word);
			respond(id, true);
		} else if (type === "reload") {
			core.reload();
			respond(id, true);
		} else {
			respond(id, null);
		}
	} catch (error) {
		port.postMessage({ id, error: String(error) });
	}
});

port.postMessage({ id: -1 });
