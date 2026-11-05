import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { type ChunkSpan, type DocumentChunk, pagesForChunkSpan } from "./chunker.ts";
import { sha256Text } from "./embedder.ts";

const SCHEMA_VERSION = 1;

const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u30fc]+/gu;
const HAS_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

const STOPWORDS = new Set(
	(
		"a an and are as at be but by can do does for from how i if in into is it its of on or should so that the their them then there these this " +
		"to was we what when where which who why will with you your about any all use using used"
	).split(" "),
);

function extractWords(text: string): string[] {
	const out: string[] = [];
	for (const seg of wordSegmenter.segment(text)) {
		if (seg.isWordLike) out.push(seg.segment);
	}
	return out;
}

function splitCamelAndIdentifierWords(word: string): string[] {
	if (HAS_CJK_RE.test(word)) return [];
	const parts = word
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((p) => p.length > 1);
	return parts.length > 1 ? parts.map((p) => p.toLowerCase()) : [];
}

function extractCjkGrams(text: string, includeUnigrams: boolean): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(CJK_RUN_RE)) {
		const chars = [...match[0]];
		if (chars.length === 1 || includeUnigrams) out.push(...chars);
		for (let i = 0; i + 1 < chars.length; i++) {
			out.push(chars[i] + chars[i + 1]);
		}
	}
	return out;
}

/** Pre-tokenize text for SQLite FTS5 (`unicode61`) with English, identifier, and CJK gram support. */
export function buildFtsIndexTokens(text: string): string {
	const raw = text.normalize("NFKC");
	const norm = raw.toLowerCase();
	const tokens: string[] = [];
	for (const w of extractWords(raw)) {
		tokens.push(w.toLowerCase());
		tokens.push(...splitCamelAndIdentifierWords(w));
	}
	tokens.push(...extractCjkGrams(norm, true));
	return tokens.join(" ");
}

export function extractQueryTokens(queryText: string): string[] {
	const raw = queryText.normalize("NFKC");
	const norm = raw.toLowerCase();
	const set = new Set<string>();
	for (const w of extractWords(raw)) {
		const lw = w.toLowerCase();
		if (HAS_CJK_RE.test(lw)) {
			if ([...lw].length <= 4) set.add(lw);
			continue;
		}
		if (lw.length < 2 && !/\d/.test(lw)) continue;
		if (STOPWORDS.has(lw)) continue;
		set.add(lw);
		for (const sub of splitCamelAndIdentifierWords(w)) {
			if (!STOPWORDS.has(sub)) set.add(sub);
		}
	}
	for (const g of extractCjkGrams(norm, false)) set.add(g);
	// Fallback if all query words were short/stopwords
	if (set.size === 0) {
		for (const w of extractWords(raw)) {
			const lw = w.toLowerCase();
			if (lw) set.add(lw);
		}
		for (const g of extractCjkGrams(norm, true)) set.add(g);
	}
	return [...set].slice(0, 64);
}

export function buildFtsMatchQuery(queryText: string): string | undefined {
	const tokens = extractQueryTokens(queryText);
	if (tokens.length === 0) return undefined;
	return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

function toF32Bytes(v: Float32Array): Uint8Array {
	return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromF32Bytes(b: Uint8Array): Float32Array {
	const copy = new Uint8Array(b.byteLength);
	copy.set(b);
	return new Float32Array(copy.buffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface StoredChunkRow {
	rid: number;
	fullHash: string;
	shortHash: string;
	filename: string;
	chunkIndex: number;
	pageStart: number;
	pageEnd: number;
	pages: number[];
	spans: ChunkSpan[];
	text: string;
	textHash: string;
	vecFingerprint: string | null;
}

export interface ChunkSearchHit {
	chunk: StoredChunkRow;
	score: number;
	vecScore?: number;
	ftsScore?: number;
	/** Exact 1-based page numbers supporting the hit within this chunk. */
	evidencePages: number[];
}

type SqlRow = Record<string, SQLInputValue>;

function parsePagesJson(raw: SQLInputValue | undefined, fallbackStart: number, fallbackEnd: number): number[] {
	if (typeof raw === "string" && raw) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				const nums = parsed.filter((x): x is number => typeof x === "number" && Number.isInteger(x));
				if (nums.length > 0) return nums;
			}
		} catch {
			// fallback below
		}
	}
	const out: number[] = [];
	for (let p = fallbackStart; p <= fallbackEnd; p++) out.push(p);
	return out;
}

function parseSpansJson(raw: SQLInputValue | undefined, pageStart: number, textLen: number): ChunkSpan[] {
	if (typeof raw === "string" && raw) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				return parsed
					.filter(
						(x): x is ChunkSpan =>
							Boolean(x) &&
							typeof x === "object" &&
							typeof (x as ChunkSpan).page === "number" &&
							typeof (x as ChunkSpan).charStart === "number" &&
							typeof (x as ChunkSpan).charEnd === "number",
					)
					.map((x) => ({
						page: x.page,
						charStart: x.charStart,
						charEnd: x.charEnd,
					}));
			}
		} catch {
			// fallback below
		}
	}
	return [{ page: pageStart, charStart: 0, charEnd: textLen }];
}

function rowToStoredChunk(r: SqlRow): StoredChunkRow {
	const pageStart = Number(r.page_start);
	const pageEnd = Number(r.page_end);
	const text = String(r.text);
	return {
		rid: Number(r.rid),
		fullHash: String(r.full_hash),
		shortHash: String(r.short_hash),
		filename: String(r.filename),
		chunkIndex: Number(r.chunk_index),
		pageStart,
		pageEnd,
		pages: parsePagesJson(r.pages_json, pageStart, pageEnd),
		spans: parseSpansJson(r.spans_json, pageStart, text.length),
		text,
		textHash: String(r.text_hash),
		vecFingerprint: r.vec_fingerprint === null || r.vec_fingerprint === undefined ? null : String(r.vec_fingerprint),
	};
}

function locateKeywordEvidencePages(chunk: StoredChunkRow, queryText: string): number[] {
	const tokens = extractQueryTokens(queryText);
	if (tokens.length === 0 || chunk.pages.length <= 1) {
		return chunk.pages;
	}
	const lowerText = chunk.text.normalize("NFKC").toLowerCase();
	const matchedPages = new Set<number>();

	for (const tok of tokens) {
		const idx = lowerText.indexOf(tok);
		if (idx >= 0) {
			for (const p of pagesForChunkSpan(chunk, { charStart: idx, charEnd: idx + tok.length })) {
				matchedPages.add(p);
			}
		}
	}

	return matchedPages.size > 0 ? [...matchedPages].sort((a, b) => a - b) : chunk.pages;
}

let bunSqliteConfigured = false;

function ensureBunCustomSqlite(): void {
	if (bunSqliteConfigured) return;
	bunSqliteConfigured = true;
	if (!("Bun" in globalThis) || process.platform !== "darwin") return;
	const candidates = [
		"/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
		"/usr/local/opt/sqlite/lib/libsqlite3.dylib",
	];
	const customPath = candidates.find((p) => existsSync(p));
	if (!customPath) return;
	try {
		const require = createRequire(import.meta.url);
		const bunSqlite = require("bun:sqlite") as {
			Database?: { setCustomSQLite?: (path: string) => void };
		};
		bunSqlite.Database?.setCustomSQLite?.(customPath);
	} catch {
		// Ignore if SQLite was already loaded or running outside Bun
	}
}

export class KbSearchIndex {
	readonly db: DatabaseSync;
	readonly dbPath: string;
	readonly vecAvailable: boolean;
	readonly vecError: string | undefined;
	private stmtCache = new Map<string, StatementSync>();

	constructor(dbPath: string) {
		this.dbPath = dbPath;
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
		}
		ensureBunCustomSqlite();
		let vecOk = false;
		let vecErr: string | undefined;
		let dbInstance: DatabaseSync;
		try {
			dbInstance = new DatabaseSync(dbPath, { allowExtension: true, timeout: 15_000 });
			try {
				const require = createRequire(import.meta.url);
				const sqliteVec = require("sqlite-vec") as { getLoadablePath(): string };
				dbInstance.loadExtension(sqliteVec.getLoadablePath());
				vecOk = true;
			} catch (err) {
				vecErr = err instanceof Error ? err.message : String(err);
			}
			try {
				dbInstance.enableLoadExtension(false);
			} catch {
				// ignore on runtimes where enableLoadExtension is not required
			}
		} catch (err) {
			vecErr = err instanceof Error ? err.message : String(err);
			dbInstance = new DatabaseSync(dbPath, { timeout: 15_000 });
		}
		this.db = dbInstance;
		this.vecAvailable = vecOk;
		this.vecError = vecErr;
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA busy_timeout = 15000");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	close(): void {
		this.stmtCache.clear();
		try {
			this.db.close();
		} catch {
			// already closed
		}
	}

	private stmt(sql: string): StatementSync {
		let s = this.stmtCache.get(sql);
		if (!s) {
			s = this.db.prepare(sql);
			this.stmtCache.set(sql, s);
		}
		return s;
	}

	tx<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const res = fn();
			this.db.exec("COMMIT");
			return res;
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// ignore rollback failure
			}
			throw err;
		}
	}

	private migrate(): void {
		const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		if (version >= SCHEMA_VERSION) return;
		this.tx(() => {
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS embeddings (
					text_hash TEXT NOT NULL,
					fingerprint TEXT NOT NULL,
					dim INTEGER NOT NULL,
					vec BLOB NOT NULL,
					created INTEGER NOT NULL,
					PRIMARY KEY (text_hash, fingerprint)
				);
				CREATE TABLE IF NOT EXISTS chunks (
					rid INTEGER PRIMARY KEY,
					full_hash TEXT NOT NULL,
					short_hash TEXT NOT NULL,
					filename TEXT NOT NULL,
					chunk_index INTEGER NOT NULL,
					page_start INTEGER NOT NULL,
					page_end INTEGER NOT NULL,
					pages_json TEXT NOT NULL,
					spans_json TEXT NOT NULL,
					text TEXT NOT NULL,
					text_hash TEXT NOT NULL,
					vec_fingerprint TEXT,
					UNIQUE (full_hash, chunk_index)
				);
				CREATE INDEX IF NOT EXISTS chunks_full_hash_idx ON chunks(full_hash, chunk_index);
				CREATE INDEX IF NOT EXISTS chunks_short_hash_idx ON chunks(short_hash);
				CREATE INDEX IF NOT EXISTS chunks_pages_idx ON chunks(full_hash, page_start, page_end);
				CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
					filename,
					content,
					tokenize = 'unicode61 remove_diacritics 2'
				);
				PRAGMA user_version = 1;
			`);
		});
	}

	getMeta(key: string): string | undefined {
		const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value;
	}

	setMeta(key: string, value: string): void {
		this.stmt(
			"INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run(key, value);
	}

	vecDim(): number | undefined {
		const raw = this.getMeta("vec_dim");
		return raw ? Number(raw) : undefined;
	}

	indexedFingerprint(): string | undefined {
		return this.getMeta("embed_fingerprint");
	}

	chunkCount(): number {
		const row = this.stmt("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
		return Number(row.n);
	}

	/**
	 * Check whether this KB's stored vector index is compatible with `currentFingerprint`.
	 * Empty KBs are always compatible. Non-empty KBs with a different fingerprint report a mismatch
	 * so old document vectors are never silently mixed with incompatible query vectors.
	 */
	checkFingerprintCompatibility(currentFingerprint: string): {
		compatible: boolean;
		storedFingerprint?: string;
	} {
		const stored = this.indexedFingerprint();
		if (!stored || this.chunkCount() === 0) {
			return { compatible: true, storedFingerprint: stored };
		}
		return {
			compatible: stored === currentFingerprint,
			storedFingerprint: stored,
		};
	}

	private ensureVecTableLocked(dim: number, fingerprint: string): void {
		if (!this.vecAvailable) return;
		const curDim = this.vecDim();
		const curFp = this.indexedFingerprint();
		const tableExists = Boolean(
			this.db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'")
				.get(),
		);
		if (curDim === dim && curFp === fingerprint && tableExists) return;
		const safeDim = Math.max(1, Math.min(65536, Math.trunc(dim)));
		const createVecSql = [
			"CREATE VIRTUAL TABLE chunks_vec USING vec0(rid INTEGER PRIMARY KEY, embedding float[",
			String(safeDim),
			"] distance_metric=cosine)",
		].join("");
		this.db.exec("DROP TABLE IF EXISTS chunks_vec");
		this.db.exec(createVecSql);
		this.db.exec("UPDATE chunks SET vec_fingerprint = NULL");
		this.setMeta("vec_dim", String(dim));
		this.setMeta("embed_fingerprint", fingerprint);
		this.stmtCache.clear();
	}

	getCachedEmbedding(textHash: string, fingerprint: string): Float32Array | undefined {
		const row = this.stmt(
			"SELECT vec FROM embeddings WHERE text_hash = ? AND fingerprint = ?",
		).get(textHash, fingerprint) as { vec: Uint8Array } | undefined;
		return row ? fromF32Bytes(row.vec) : undefined;
	}

	putCachedEmbedding(textHash: string, fingerprint: string, vec: Float32Array): void {
		this.stmt(
			`INSERT INTO embeddings(text_hash, fingerprint, dim, vec, created)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(text_hash, fingerprint) DO UPDATE SET
			   dim = excluded.dim,
			   vec = excluded.vec,
			   created = excluded.created`,
		).run(textHash, fingerprint, vec.length, toF32Bytes(vec), Date.now());
	}

	/** Replace all chunks, FTS entries, and vectors for a document inside an atomic transaction. */
	indexDocumentChunks(params: {
		fullHash: string;
		shortHash: string;
		filename: string;
		chunks: DocumentChunk[];
		vectors: Float32Array[];
		fingerprint: string;
	}): void {
		const { fullHash, shortHash, filename, chunks, vectors, fingerprint } = params;
		if (chunks.length !== vectors.length) {
			throw new Error(`Chunk/vector count mismatch (${chunks.length} chunks vs ${vectors.length} vectors)`);
		}
		const existingFp = this.indexedFingerprint();
		const otherChunks = (
			this.stmt("SELECT COUNT(*) AS n FROM chunks WHERE full_hash != ?").get(fullHash) as { n: number }
		).n;
		if (existingFp && existingFp !== fingerprint && Number(otherChunks) > 0) {
			throw new Error(
				`Embedding configuration mismatch: KB index uses "${existingFp}", but current config is "${fingerprint}".`,
			);
		}

		this.tx(() => {
			if (vectors.length > 0) {
				this.ensureVecTableLocked(vectors[0].length, fingerprint);
			} else if (!existingFp) {
				this.setMeta("embed_fingerprint", fingerprint);
			}

			// Remove any existing chunks for this source first
			const oldRows = this.stmt("SELECT rid FROM chunks WHERE full_hash = ?").all(fullHash) as Array<{
				rid: number;
			}>;
			for (const r of oldRows) {
				const rid = Number(r.rid);
				this.stmt("DELETE FROM chunks_fts WHERE rowid = ?").run(rid);
				if (this.vecAvailable && this.vecDim()) {
					this.stmt("DELETE FROM chunks_vec WHERE rid = ?").run(BigInt(rid));
				}
			}
			this.stmt("DELETE FROM chunks WHERE full_hash = ?").run(fullHash);

			const filenameTokens = buildFtsIndexTokens(filename);

			for (let i = 0; i < chunks.length; i++) {
				const ch = chunks[i];
				const vec = vectors[i];
				const textHash = sha256Text(ch.text);

				this.putCachedEmbedding(textHash, fingerprint, vec);

				const insertRes = this.stmt(
					`INSERT INTO chunks(
						full_hash, short_hash, filename, chunk_index,
						page_start, page_end, pages_json, spans_json,
						text, text_hash, vec_fingerprint
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					fullHash,
					shortHash,
					filename,
					ch.chunkIndex,
					ch.pageStart,
					ch.pageEnd,
					JSON.stringify(ch.pages),
					JSON.stringify(ch.spans),
					ch.text,
					textHash,
					fingerprint,
				);
				const rid = Number(insertRes.lastInsertRowid);

				this.stmt("INSERT INTO chunks_fts(rowid, filename, content) VALUES (?, ?, ?)").run(
					rid,
					filenameTokens,
					buildFtsIndexTokens(ch.text),
				);

				if (this.vecAvailable) {
					this.stmt("DELETE FROM chunks_vec WHERE rid = ?").run(BigInt(rid));
					this.stmt("INSERT INTO chunks_vec(rid, embedding) VALUES (?, ?)").run(
						BigInt(rid),
						toF32Bytes(vec),
					);
				}
			}
		});
	}

	getChunksForSource(fullHash: string): StoredChunkRow[] {
		const rows = this.stmt(
			"SELECT * FROM chunks WHERE full_hash = ? ORDER BY chunk_index ASC",
		).all(fullHash) as SqlRow[];
		return rows.map(rowToStoredChunk);
	}

	getChunkWindow(fullHash: string, centerChunkIndex: number, neighbors = 1): StoredChunkRow[] {
		const minIdx = Math.max(0, centerChunkIndex - Math.max(0, neighbors));
		const maxIdx = centerChunkIndex + Math.max(0, neighbors);
		const rows = this.stmt(
			"SELECT * FROM chunks WHERE full_hash = ? AND chunk_index >= ? AND chunk_index <= ? ORDER BY chunk_index ASC",
		).all(fullHash, minIdx, maxIdx) as SqlRow[];
		return rows.map(rowToStoredChunk);
	}

	getChunksByPageRange(fullHash: string, pageStart: number, pageEnd = pageStart): StoredChunkRow[] {
		const rows = this.stmt(
			"SELECT * FROM chunks WHERE full_hash = ? AND page_end >= ? AND page_start <= ? ORDER BY chunk_index ASC",
		).all(fullHash, pageStart, pageEnd) as SqlRow[];
		return rows.map(rowToStoredChunk);
	}

	/** Full-text BM25 keyword search over `chunks_fts`. */
	ftsSearch(queryText: string, limit: number): Array<{ rid: number; score: number }> {
		const matchExpr = buildFtsMatchQuery(queryText);
		if (!matchExpr) return [];
		try {
			const rows = this.stmt(
				`SELECT f.rowid AS rid, bm25(chunks_fts, 1.5, 1.0) AS score
				 FROM chunks_fts f
				 WHERE chunks_fts MATCH ?
				 ORDER BY score ASC
				 LIMIT ?`,
			).all(matchExpr, Math.max(1, limit)) as Array<{ rid: number; score: number }>;
			return rows.map((r) => ({ rid: Number(r.rid), score: Math.max(0.0001, -Number(r.score)) }));
		} catch {
			return [];
		}
	}

	/** Vector cosine similarity search over `chunks_vec` (with brute-force fallback if sqlite-vec is unavailable). */
	vecSearch(
		queryVec: Float32Array,
		fingerprint: string,
		limit: number,
	): Array<{ rid: number; score: number }> {
		const k = Math.max(1, Math.min(1024, Math.floor(limit)));
		if (this.vecAvailable) {
			const dim = this.vecDim();
			const storedFp = this.indexedFingerprint();
			if (!dim || dim !== queryVec.length || (storedFp && storedFp !== fingerprint)) {
				return [];
			}
			try {
				const rows = this.stmt(
					"SELECT rid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?",
				).all(toF32Bytes(queryVec), k) as Array<{ rid: number; distance: number }>;
				return rows
					.map((r) => ({ rid: Number(r.rid), score: 1 - Number(r.distance) }))
					.sort((a, b) => b.score - a.score);
			} catch {
				// fallback below if vec0 table not created yet
			}
		}

		const rows = this.stmt(
			`SELECT c.rid AS rid, e.vec AS vec
			 FROM chunks c
			 JOIN embeddings e ON e.text_hash = c.text_hash AND e.fingerprint = ?`,
		).all(fingerprint) as Array<{ rid: number; vec: Uint8Array }>;

		return rows
			.map((r) => ({ rid: Number(r.rid), score: cosineSimilarity(queryVec, fromF32Bytes(r.vec)) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}

	/**
	 * Hybrid retrieval combining vector similarity (`sqlite-vec`) and keyword BM25 (`FTS5`)
	 * using Reciprocal Rank Fusion (RRF) + cosine bonus.
	 */
	hybridSearch(params: {
		queryText: string;
		queryVec?: Float32Array;
		fingerprint?: string;
		limit?: number;
	}): ChunkSearchHit[] {
		const limit = Math.max(1, params.limit ?? 8);
		const candidatePool = Math.max(24, limit * 4);

		const vecHits =
			params.queryVec && params.fingerprint
				? this.vecSearch(params.queryVec, params.fingerprint, candidatePool)
				: [];
		const ftsHits = this.ftsSearch(params.queryText, candidatePool);

		if (vecHits.length === 0 && ftsHits.length === 0) return [];

		const rrfK = 50;
		const combined = new Map<
			number,
			{ rrf: number; vecScore?: number; ftsScore?: number }
		>();

		for (let i = 0; i < vecHits.length; i++) {
			const h = vecHits[i];
			const cur = combined.get(h.rid) ?? { rrf: 0 };
			cur.rrf += 1.15 / (rrfK + i + 1) + Math.max(0, h.score) * 0.015;
			cur.vecScore = h.score;
			combined.set(h.rid, cur);
		}

		for (let i = 0; i < ftsHits.length; i++) {
			const h = ftsHits[i];
			const cur = combined.get(h.rid) ?? { rrf: 0 };
			cur.rrf += 1.0 / (rrfK + i + 1);
			cur.ftsScore = h.score;
			combined.set(h.rid, cur);
		}

		const rankedRids = [...combined.entries()]
			.sort((a, b) => b[1].rrf - a[1].rrf)
			.slice(0, candidatePool)
			.map(([rid]) => rid);

		const rows = this.stmt(
			"SELECT * FROM chunks WHERE rid IN (SELECT value FROM json_each(?))",
		).all(JSON.stringify(rankedRids)) as SqlRow[];
		const byRid = new Map<number, StoredChunkRow>();
		for (const r of rows) {
			const c = rowToStoredChunk(r);
			byRid.set(c.rid, c);
		}

		const results: ChunkSearchHit[] = [];
		for (const rid of rankedRids) {
			const chunk = byRid.get(rid);
			const meta = combined.get(rid);
			if (!chunk || !meta) continue;
			const evidencePages = locateKeywordEvidencePages(chunk, params.queryText);
			results.push({
				chunk,
				score: meta.rrf,
				vecScore: meta.vecScore,
				ftsScore: meta.ftsScore,
				evidencePages,
			});
			if (results.length >= limit * 2) break;
		}

		return results.slice(0, limit);
	}
}
