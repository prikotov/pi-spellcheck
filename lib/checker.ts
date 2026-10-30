/**
 * Асинхронная обёртка над SpellCore.
 *
 * Словари грузятся ~2 секунды монолитного CPU — если делать это в главном
 * потоке pi, первые нажатия клавиш залипают. Поэтому вся тяжёлая работа
 * живёт в worker thread, а главный поток:
 *  - держит LRU-кеш последних результатов для синхронного рендера
 *    (подчёркивание доезжает на несколько кадров позже — незаметно);
 *  - ждёт ответа воркера только там, где и так асинхронно (gate-диалог,
 *    диалог исправлений).
 *
 * Если worker_threads недоступны — fallback на синхронный SpellCore
 * (старое поведение, с блокировкой).
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { SpellCore, matchCase, type DictionarySpec } from "./spell-core.ts";

export interface SpellCheckerOptions {
	dictionaries: DictionarySpec[];
	/** One word per line, `#` comments allowed. */
	userDictPaths: string[];
}

const CACHE_LIMIT = 48;

interface PendingEntry {
	promise: Promise<void>;
}

export class SpellChecker {
	readonly options: SpellCheckerOptions;
	private worker: Worker | null = null;
	private workerReady = false;
	private workerFailed = false;
	private disposed = false;
	private messageId = 0;
	private pending = new Map<number, (value: unknown) => void>();
	private cache = new Map<string, Set<string>>();
	private inflight = new Map<string, PendingEntry>();
	/** Синхронный fallback, используется только когда воркер не стартовал. */
	private core: SpellCore | null = null;

	constructor(options: SpellCheckerOptions) {
		this.options = options;
	}

	/** Начать загрузку словарей заранее (не блокируя главный поток). */
	warmup(): void {
		this.ensureWorker();
	}

	/** Ленивый старт воркера при первом использовании. */
	private ensureWorker(): Worker | null {
		if (this.disposed) return null;
		if (this.core || this.workerFailed) return null; // fallback-режим
		if (this.worker) return this.worker;
		try {
			const workerPath = fileURLToPath(new URL("../worker/spell-worker.mjs", import.meta.url));
			const worker = new Worker(workerPath, {
				workerData: {
					dictionaries: this.options.dictionaries,
					userDictPaths: this.options.userDictPaths,
				},
			});
			worker.on("message", (message: { id: number; payload?: unknown; error?: string }) => {
				if (message.id === -1) {
					// ready-сигнал после загрузки словарей
					this.workerReady = true;
					return;
				}
				const resolve = this.pending.get(message.id);
				if (resolve) {
					this.pending.delete(message.id);
					resolve(message.payload);
				}
			});
			worker.on("error", () => {
				this.workerFailed = true;
				this.workerReady = false;
				// Проваливаем все висящие запросы: подчёркивание просто не покажется.
				for (const resolve of this.pending.values()) resolve(undefined);
				this.pending.clear();
			});
			this.worker = worker;
			return worker;
		} catch {
			this.workerFailed = true;
			return null;
		}
	}

	private postToWorker<T>(type: string, payload: Record<string, unknown>): Promise<T> | null {
		const worker = this.ensureWorker();
		if (!worker) return null;
		const id = ++this.messageId;
		return new Promise<T>((resolve) => {
			this.pending.set(id, (value) => resolve(value as T));
			worker.postMessage({ id, type, ...payload });
		});
	}

	/** Готов ли проверщик (воркер загрузил словари либо включён fallback). */
	get isReady(): boolean {
		if (this.core) return this.core.isReady;
		return this.workerReady;
	}

	/**
	 * Запросить проверку текста (дедуп по тексту). Промис резолвится,
	 * когда результат окажется в кеше.
	 */
	requestCheck(text: string): Promise<void> {
		if (this.core) {
			// Синхронный fallback: считаем сразу.
			this.cacheSet(text, this.core.misspelledInText(text));
			return Promise.resolve();
		}
		if (this.cache.has(text)) return Promise.resolve();
		const existing = this.inflight.get(text);
		if (existing) return existing.promise;

		let resolveDone!: () => void;
		const promise = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		this.inflight.set(text, { promise });

		const promiseToWorker = this.postToWorker<string[]>("check", { text });
		if (!promiseToWorker) {
			// Воркер не смог стартовать после поста — включаем fallback.
			this.enableFallback();
			this.cacheSet(text, this.core!.misspelledInText(text));
			this.inflight.delete(text);
			resolveDone();
			return promise;
		}
		void promiseToWorker.then((words) => {
			this.inflight.delete(text);
			if (Array.isArray(words)) {
				this.cacheSet(text, words);
			}
			resolveDone();
		});
		return promise;
	}

	/** Последний известный набор опечаток для текста (для синхронного рендера). */
	getSet(text: string): Set<string> | undefined {
		return this.cache.get(text);
	}

	/** Точный список опечаток — используется в асинхронных потоках (gate, диалог). */
	async checkText(text: string): Promise<string[]> {
		if (this.core) return this.core.misspelledInText(text);
		await this.requestCheck(text);
		return Array.from(this.cache.get(text) ?? []);
	}

	async suggest(word: string): Promise<string[]> {
		if (this.core) return this.core.suggest(word);
		const payload = await this.postToWorker<string[]>("suggest", { word });
		return Array.isArray(payload) ? payload : [];
	}

	addUserWord(word: string): void {
		if (this.core) {
			this.core.addUserWord(word);
			return;
		}
		const worker = this.ensureWorker();
		worker?.postMessage({ id: ++this.messageId, type: "addWord", word });
		this.cache.clear();
	}

	reload(): void {
		if (this.core) {
			this.core.reload();
			this.cache.clear();
			return;
		}
		const worker = this.ensureWorker();
		worker?.postMessage({ id: ++this.messageId, type: "reload" });
		this.cache.clear();
	}

	private enableFallback(): void {
		if (this.core) return;
		this.core = new SpellCore(this.options);
		this.core.load();
		this.workerFailed = true;
	}

	private cacheSet(text: string, words: string[]): void {
		if (this.cache.size >= CACHE_LIMIT) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.delete(text);
		this.cache.set(text, new Set(words));
	}

	/** Остановить воркер (при закрытии сессии). */
	dispose(): void {
		this.disposed = true;
		this.cache.clear();
		this.inflight.clear();
		if (this.worker) {
			void this.worker.terminate();
			this.worker = null;
		}
	}
}

export { matchCase };
