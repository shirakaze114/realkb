import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	closeSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultRealkbDir } from "./config.ts";
import { withFileLock } from "./lock.ts";

export interface RealkbState {
	lastKbId: number;
}

export interface KbMeta {
	/** Zero-padded permanent numeric ID (e.g. "001", "002"). */
	id: string;
	/** Numeric form of `id` (e.g. 1, 2). */
	numericId: number;
	/** Display name of the knowledge base. */
	name: string;
	createdAt: string;
	updatedAt: string;
}

export type SourceStatus = "extracting" | "extracted" | "indexing" | "ready" | "failed";
export type FailingStep = "extract" | "chunk" | "embed" | "index";
export type SupportedSourceExt = "pdf" | "md" | "txt";

export const SUPPORTED_SOURCE_EXTS: readonly SupportedSourceExt[] = ["pdf", "md", "txt"];

export function normalizeSourceExt(extOrFilename: string): SupportedSourceExt | undefined {
	const raw = extOrFilename.trim().toLowerCase();
	if (!raw) return undefined;
	const dotIdx = raw.lastIndexOf(".");
	const token = dotIdx >= 0 ? raw.slice(dotIdx + 1) : raw;
	if (token === "pdf") return "pdf";
	if (token === "md" || token === "markdown") return "md";
	if (token === "txt") return "txt";
	return undefined;
}

export interface SourceMeta {
	fullHash: string;
	shortHash: string;
	originalFilename: string;
	originalPath: string;
	objectRelPath: string;
	sourceType?: SupportedSourceExt;
	fileSize: number;
	importedAt: string;
	updatedAt: string;
	status: SourceStatus;
	failingStep?: FailingStep;
	error?: string;
	pageCount: number;
	usableTextPages: number;
	unreadablePages: number[];
	figureCount: number;
	chunkCount?: number;
	embeddingFingerprint?: string;
}

export interface ExtractedLine {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ExtractedPage {
	/** 1-based PDF page number. */
	pageNumber: number;
	/** Full extracted text for this page, including page-numbered figure markers (`[FIG p7-1]`). */
	text: string;
	/** Whether this page yielded meaningful selectable text. */
	hasUsableText: boolean;
	/** Figure markers inserted on this page. */
	figureMarkers: string[];
	/** Structured line items with layout coordinates for chunking cleanup. */
	lines?: ExtractedLine[];
}

export interface PagesData {
	fullHash: string;
	pageCount: number;
	extractedAt: string;
	pages: ExtractedPage[];
}

export interface ParsedReference {
	/** Normalized KB ID (e.g. "001"). */
	kbId: string;
	/** Short or full hex source hash (`7..64` lowercase hex characters). */
	sourceHash: string;
	/** Optional 1-based PDF page number from `p<N>`. */
	page?: number;
}

export interface PathInspectionResult {
	validPdfFiles: string[];
	unexpectedFiles: Array<{ rootInput: string; filePath: string; reason: string }>;
	missingPaths: string[];
}

export function formatKbId(num: number): string {
	return String(num).padStart(3, "0");
}

export function normalizeKbIdInput(input: string): string | undefined {
	const trimmed = input.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(n) || n <= 0) return undefined;
	return formatKbId(n);
}

export function ensureStorageDirs(rootDir = defaultRealkbDir()): void {
	mkdirSync(rootDir, { recursive: true, mode: 0o700 });
	mkdirSync(join(rootDir, "objects"), { recursive: true, mode: 0o700 });
	mkdirSync(join(rootDir, "kbs"), { recursive: true, mode: 0o700 });
	mkdirSync(join(rootDir, "tmp"), { recursive: true, mode: 0o700 });
}

export function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
	renameSync(tmp, filePath);
	try {
		chmodSync(filePath, mode);
	} catch {
		// best effort
	}
}

export function stateFilePath(rootDir = defaultRealkbDir()): string {
	return join(rootDir, "state.json");
}

export function loadState(rootDir = defaultRealkbDir()): RealkbState {
	const file = stateFilePath(rootDir);
	if (!existsSync(file)) return { lastKbId: 0 };
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { lastKbId?: unknown };
		const lastKbId =
			typeof raw?.lastKbId === "number" && Number.isInteger(raw.lastKbId) && raw.lastKbId >= 0
				? raw.lastKbId
				: 0;
		return { lastKbId };
	} catch {
		return { lastKbId: 0 };
	}
}

function highestExistingKbNumericId(rootDir: string): number {
	const kbsDir = join(rootDir, "kbs");
	if (!existsSync(kbsDir)) return 0;
	let maxId = 0;
	for (const entry of readdirSync(kbsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (/^\d+$/.test(entry.name)) {
			const n = Number.parseInt(entry.name, 10);
			if (Number.isInteger(n) && n > maxId) maxId = n;
		}
		const kbJsonPath = join(kbsDir, entry.name, "kb.json");
		if (existsSync(kbJsonPath)) {
			try {
				const meta = JSON.parse(readFileSync(kbJsonPath, "utf8")) as Partial<KbMeta>;
				if (typeof meta.numericId === "number" && Number.isInteger(meta.numericId) && meta.numericId > maxId) {
					maxId = meta.numericId;
				}
			} catch {
				// ignore malformed kb.json when scanning max ID
			}
		}
	}
	return maxId;
}

export function kbDir(rootDir: string, kbId: string): string {
	return join(rootDir, "kbs", kbId);
}

export function kbMetaPath(rootDir: string, kbId: string): string {
	return join(kbDir(rootDir, kbId), "kb.json");
}

export function kbIndexDbPath(rootDir: string, kbId: string): string {
	return join(kbDir(rootDir, kbId), "index", "search.sqlite");
}

export function objectFilePath(
	rootDir: string,
	fullHash: string,
	ext: SupportedSourceExt = "pdf",
): string {
	return join(rootDir, "objects", `${fullHash}.${ext}`);
}

export function objectPdfPath(rootDir: string, fullHash: string): string {
	for (const ext of SUPPORTED_SOURCE_EXTS) {
		const candidate = objectFilePath(rootDir, fullHash, ext);
		if (existsSync(candidate)) return candidate;
	}
	return objectFilePath(rootDir, fullHash, "pdf");
}

export function sourceDir(rootDir: string, kbId: string, fullHash: string): string {
	return join(kbDir(rootDir, kbId), "sources", fullHash);
}

export function sourceMetaPath(rootDir: string, kbId: string, fullHash: string): string {
	return join(sourceDir(rootDir, kbId, fullHash), "source.json");
}

export function sourcePagesPath(rootDir: string, kbId: string, fullHash: string): string {
	return join(sourceDir(rootDir, kbId, fullHash), "pages.json");
}

/** Discover all KBs by scanning `kbs/* /kb.json`. */
export function listKbs(rootDir = defaultRealkbDir()): KbMeta[] {
	const kbsDir = join(rootDir, "kbs");
	if (!existsSync(kbsDir)) return [];
	const out: KbMeta[] = [];
	for (const entry of readdirSync(kbsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const metaFile = join(kbsDir, entry.name, "kb.json");
		if (!existsSync(metaFile)) continue;
		try {
			const raw = JSON.parse(readFileSync(metaFile, "utf8")) as Partial<KbMeta>;
			const id = typeof raw.id === "string" && raw.id ? raw.id : entry.name;
			const numericId =
				typeof raw.numericId === "number" && Number.isInteger(raw.numericId)
					? raw.numericId
					: Number.parseInt(id, 10);
			if (!Number.isInteger(numericId) || numericId <= 0 || typeof raw.name !== "string") continue;
			out.push({
				id: formatKbId(numericId),
				numericId,
				name: raw.name,
				createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
				updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
			});
		} catch {
			// skip unreadable kb.json
		}
	}
	out.sort((a, b) => a.numericId - b.numericId);
	return out;
}

/** Resolve a KB by numeric ID ("001" or "1") or case-insensitive name. */
export function resolveKb(rootDir: string, idOrName: string): KbMeta | undefined {
	const query = idOrName.trim();
	if (!query) return undefined;
	const kbs = listKbs(rootDir);
	const normalizedId = normalizeKbIdInput(query);
	if (normalizedId) {
		const byId = kbs.find((k) => k.id === normalizedId);
		if (byId) return byId;
	}
	const lower = query.toLowerCase();
	return kbs.find((k) => k.name.trim().toLowerCase() === lower);
}

/** Create a new KB with a permanently unique numeric ID under `<rootDir>/kbs/<id>/kb.json`. */
export async function createKb(name: string, rootDir = defaultRealkbDir()): Promise<KbMeta> {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Knowledge base name must not be empty");
	ensureStorageDirs(rootDir);
	return withFileLock(rootDir, "state", () => {
		const existing = listKbs(rootDir);
		const dup = existing.find((k) => k.name.trim().toLowerCase() === trimmed.toLowerCase());
		if (dup) {
			throw new Error(`Knowledge base "${dup.name}" already exists (ID ${dup.id})`);
		}
		const state = loadState(rootDir);
		const maxFolder = highestExistingKbNumericId(rootDir);
		const nextNumeric = Math.max(state.lastKbId, maxFolder) + 1;
		const id = formatKbId(nextNumeric);
		const now = new Date().toISOString();
		const meta: KbMeta = {
			id,
			numericId: nextNumeric,
			name: trimmed,
			createdAt: now,
			updatedAt: now,
		};
		atomicWriteJson(stateFilePath(rootDir), { lastKbId: nextNumeric } satisfies RealkbState);
		const dir = kbDir(rootDir, id);
		mkdirSync(join(dir, "sources"), { recursive: true, mode: 0o700 });
		mkdirSync(join(dir, "index"), { recursive: true, mode: 0o700 });
		atomicWriteJson(kbMetaPath(rootDir, id), meta);
		return meta;
	});
}

/** Compute SHA-256 hex digest of a file's raw bytes. */
export function hashFileSha256(filePath: string): { fullHash: string; bytes: Buffer } {
	const bytes = readFileSync(filePath);
	const fullHash = createHash("sha256").update(bytes).digest("hex");
	return { fullHash, bytes };
}

/** Ensure `<rootDir>/objects/<fullHash>.<ext>` exists without duplicating copies. */
export function ensureSharedOriginalPdf(
	rootDir: string,
	fullHash: string,
	inputFilePath: string,
	extOverride?: SupportedSourceExt,
): string {
	ensureStorageDirs(rootDir);
	const ext = extOverride ?? normalizeSourceExt(extname(inputFilePath)) ?? "pdf";
	const target = objectFilePath(rootDir, fullHash, ext);
	if (existsSync(target)) return target;
	const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	copyFileSync(inputFilePath, tmp);
	try {
		chmodSync(tmp, 0o600);
	} catch {
		// best effort
	}
	renameSync(tmp, target);
	return target;
}

/** List all `SourceMeta` records in a KB. */
export function listSourcesInKb(rootDir: string, kbId: string): SourceMeta[] {
	const dir = join(kbDir(rootDir, kbId), "sources");
	if (!existsSync(dir)) return [];
	const out: SourceMeta[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const metaFile = join(dir, entry.name, "source.json");
		if (!existsSync(metaFile)) continue;
		try {
			const meta = JSON.parse(readFileSync(metaFile, "utf8")) as SourceMeta;
			if (meta && typeof meta.fullHash === "string" && typeof meta.shortHash === "string") {
				out.push(meta);
			}
		} catch {
			// ignore unreadable source.json
		}
	}
	out.sort((a, b) => a.importedAt.localeCompare(b.importedAt));
	return out;
}

export function loadSourceMeta(rootDir: string, kbId: string, fullHash: string): SourceMeta | undefined {
	const file = sourceMetaPath(rootDir, kbId, fullHash);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as SourceMeta;
	} catch {
		return undefined;
	}
}

export function saveSourceMeta(rootDir: string, kbId: string, meta: SourceMeta): void {
	atomicWriteJson(sourceMetaPath(rootDir, kbId, meta.fullHash), meta);
}

export function loadSourcePages(rootDir: string, kbId: string, fullHash: string): PagesData | undefined {
	const file = sourcePagesPath(rootDir, kbId, fullHash);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as PagesData;
	} catch {
		return undefined;
	}
}

export function saveSourcePages(rootDir: string, kbId: string, data: PagesData): void {
	atomicWriteJson(sourcePagesPath(rootDir, kbId, data.fullHash), data);
}

/**
 * Assign a short hex hash (`7` chars by default) for `fullHash` in `kbId`.
 * If `fullHash` was already imported into `kbId`, preserves its existing `shortHash`.
 * If a different source in `kbId` shares the 7-char prefix, extends the new source's prefix
 * (`8+` chars) until unique in `kbId`, without modifying existing sources' issued IDs.
 */
export function assignShortHash(rootDir: string, kbId: string, fullHash: string): string {
	const existingSame = loadSourceMeta(rootDir, kbId, fullHash);
	if (existingSame?.shortHash) return existingSame.shortHash;

	const others = listSourcesInKb(rootDir, kbId).filter((s) => s.fullHash !== fullHash);
	for (let len = 7; len <= fullHash.length; len++) {
		const candidate = fullHash.slice(0, len);
		const collides = others.some(
			(s) => s.shortHash === candidate || s.fullHash.startsWith(candidate),
		);
		if (!collides) return candidate;
	}
	return fullHash;
}

/** Resolve a short or full source hash inside a KB. */
export function resolveSourceInKb(rootDir: string, kbId: string, hashOrPrefix: string): SourceMeta | undefined {
	const clean = hashOrPrefix.trim().toLowerCase();
	if (!/^[0-9a-f]{7,64}$/.test(clean)) return undefined;
	if (clean.length === 64) {
		const exact = loadSourceMeta(rootDir, kbId, clean);
		if (exact) return exact;
	}
	const sources = listSourcesInKb(rootDir, kbId);
	const exactShort = sources.find((s) => s.shortHash.toLowerCase() === clean);
	if (exactShort) return exactShort;
	const prefixMatches = sources.filter((s) => s.fullHash.toLowerCase().startsWith(clean));
	if (prefixMatches.length === 1) return prefixMatches[0];
	return undefined;
}

/**
 * Format a source or page citation:
 * - Document citation: `[rkb:001_c676ea9]`
 * - Page citation: `[rkb:001_c676ea9p7]`
 */
export function formatCitation(kbId: string, shortHash: string, page?: number): string {
	const normKb = normalizeKbIdInput(kbId) ?? kbId;
	if (page !== undefined && Number.isInteger(page) && page >= 1) {
		return `[rkb:${normKb}_${shortHash}p${page}]`;
	}
	return `[rkb:${normKb}_${shortHash}]`;
}

/**
 * Format a clickable `file://` URL to the stored original source file (with `#page=N` when a PDF page is given).
 */
export function formatPdfFileUrl(rootDir: string, fullHash: string, page?: number): string {
	const filePath = objectPdfPath(rootDir, fullHash);
	const base = pathToFileURL(filePath).href;
	if (
		filePath.toLowerCase().endsWith(".pdf") &&
		page !== undefined &&
		Number.isInteger(page) &&
		page >= 1
	) {
		return `${base}#page=${page}`;
	}
	return base;
}

/**
 * Parse a tool reference or citation string:
 * Accepts `[rkb:001_c676ea9p7]`, `rkb:001_c676ea9p7`, `001_c676ea9p7`, `001:c676ea9p7`,
 * or document-only forms without `p<page>`.
 */
export function parseReference(ref: string): ParsedReference | undefined {
	let s = ref.trim();
	if (s.startsWith("[") && s.endsWith("]")) {
		s = s.slice(1, -1).trim();
	}
	if (s.toLowerCase().startsWith("rkb:")) {
		s = s.slice(4).trim();
	}
	const m = /^(\d+)[_:]([0-9a-fA-F]{7,64})(?:,?p([1-9]\d*))?$/.exec(s);
	if (!m) return undefined;
	const kbId = normalizeKbIdInput(m[1]);
	if (!kbId) return undefined;
	const sourceHash = m[2].toLowerCase();
	const page = m[3] ? Number.parseInt(m[3], 10) : undefined;
	return { kbId, sourceHash, page };
}

function hasPdfMagicHeader(filePath: string): boolean {
	try {
		const fd = openSync(filePath, "r");
		try {
			const buf = Buffer.alloc(5);
			const bytesRead = readSync(fd, buf, 0, 5, 0);
			return bytesRead === 5 && buf.toString("ascii") === "%PDF-";
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

function isReadableTextFile(filePath: string): boolean {
	try {
		const fd = openSync(filePath, "r");
		try {
			const buf = Buffer.alloc(4096);
			const bytesRead = readSync(fd, buf, 0, 4096, 0);
			for (let i = 0; i < bytesRead; i++) {
				if (buf[i] === 0) return false;
			}
			return true;
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

/**
 * Inspect input file/directory paths before importing:
 * - Skips all dot-files and dot-directories (names starting with `.`, such as `.DS_Store` and `.git`).
 * - Single specific file paths allow `.pdf`, `.md`, and `.txt` automatically without needing `allowExt`.
 * - Directory paths allow `.pdf` by default, plus any additional extensions specified in `allowExt` (`"md"`, `"txt"`).
 * - Flags any disallowed or invalid file inside a directory so mixed directories are never imported unexpectedly.
 */
export function inspectImportPaths(
	inputPaths: string[],
	cwd: string,
	allowExt?: string[],
): PathInspectionResult {
	const validPdfFiles: string[] = [];
	const seenFiles = new Set<string>();
	const unexpectedFiles: Array<{ rootInput: string; filePath: string; reason: string }> = [];
	const missingPaths: string[] = [];

	const allowedInDir = new Set<SupportedSourceExt>(["pdf"]);
	if (Array.isArray(allowExt)) {
		for (const item of allowExt) {
			const norm = normalizeSourceExt(item);
			if (norm) allowedInDir.add(norm);
		}
	}

	const validateSourceFile = (
		fullPath: string,
		ext: SupportedSourceExt,
	): { ok: true } | { ok: false; reason: string } => {
		if (ext === "pdf") {
			if (!hasPdfMagicHeader(fullPath)) {
				return { ok: false, reason: "file does not have a valid %PDF- header" };
			}
			return { ok: true };
		}
		if (!isReadableTextFile(fullPath)) {
			return { ok: false, reason: `binary or unreadable .${ext} text file` };
		}
		return { ok: true };
	};

	const walkDir = (rootInput: string, currentDir: string) => {
		const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const fullPath = join(currentDir, entry.name);
			if (entry.isDirectory()) {
				walkDir(rootInput, fullPath);
			} else if (entry.isFile()) {
				const ext = normalizeSourceExt(extname(entry.name));
				if (!ext || !allowedInDir.has(ext)) {
					const hint =
						ext && (ext === "md" || ext === "txt")
							? `non-PDF (.${ext}) file in directory (pass allow_ext: ["${ext}"] to include .${ext} files from directories)`
							: "non-PDF file in directory";
					unexpectedFiles.push({
						rootInput,
						filePath: relative(rootInput, fullPath) || entry.name,
						reason: hint,
					});
					continue;
				}
				const check = validateSourceFile(fullPath, ext);
				if (!check.ok) {
					unexpectedFiles.push({
						rootInput,
						filePath: relative(rootInput, fullPath) || entry.name,
						reason: check.reason,
					});
					continue;
				}
				if (!seenFiles.has(fullPath)) {
					seenFiles.add(fullPath);
					validPdfFiles.push(fullPath);
				}
			} else {
				unexpectedFiles.push({
					rootInput,
					filePath: relative(rootInput, fullPath) || entry.name,
					reason: "unsupported special file or symlink",
				});
			}
		}
	};

	for (const rawPath of inputPaths) {
		const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
		if (!existsSync(resolved)) {
			missingPaths.push(rawPath);
			continue;
		}
		const st = statSync(resolved);
		if (st.isDirectory()) {
			walkDir(resolved, resolved);
		} else if (st.isFile()) {
			const ext = normalizeSourceExt(extname(resolved));
			if (!ext) {
				unexpectedFiles.push({
					rootInput: rawPath,
					filePath: basename(resolved),
					reason: "unsupported file extension (expected .pdf, .md, or .txt)",
				});
				continue;
			}
			const check = validateSourceFile(resolved, ext);
			if (!check.ok) {
				unexpectedFiles.push({
					rootInput: rawPath,
					filePath: basename(resolved),
					reason: check.reason,
				});
				continue;
			}
			if (!seenFiles.has(resolved)) {
				seenFiles.add(resolved);
				validPdfFiles.push(resolved);
			}
		} else {
			unexpectedFiles.push({
				rootInput: rawPath,
				filePath: basename(resolved),
				reason: "not a regular file or directory",
			});
		}
	}

	return { validPdfFiles, unexpectedFiles, missingPaths };
}

/**
 * Explicitly remove shared PDFs in `objects/` that are not referenced by any KB (`kbs/* /sources/*`).
 * Never deletes a PDF still referenced by any KB.
 */
export async function cleanupUnreferencedObjects(rootDir = defaultRealkbDir()): Promise<{
	deletedCount: number;
	deletedBytes: number;
	retainedCount: number;
	deletedHashes: string[];
}> {
	ensureStorageDirs(rootDir);
	return withFileLock(rootDir, "import", () => {
		const referenced = new Set<string>();
		const kbsDir = join(rootDir, "kbs");
		if (existsSync(kbsDir)) {
			for (const kbEntry of readdirSync(kbsDir, { withFileTypes: true })) {
				if (!kbEntry.isDirectory() || kbEntry.name.startsWith(".")) continue;
				const sourcesPath = join(kbsDir, kbEntry.name, "sources");
				if (!existsSync(sourcesPath)) continue;
				for (const srcEntry of readdirSync(sourcesPath, { withFileTypes: true })) {
					if (!srcEntry.isDirectory() || srcEntry.name.startsWith(".")) continue;
					referenced.add(srcEntry.name.toLowerCase());
					const metaPath = join(sourcesPath, srcEntry.name, "source.json");
					if (existsSync(metaPath)) {
						try {
							const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<SourceMeta>;
							if (typeof meta.fullHash === "string") {
								referenced.add(meta.fullHash.toLowerCase());
							}
						} catch {
							// keep folder name in referenced set to be safe
						}
					}
				}
			}
		}

		const objectsDir = join(rootDir, "objects");
		let deletedCount = 0;
		let deletedBytes = 0;
		let retainedCount = 0;
		const deletedHashes: string[] = [];

		if (existsSync(objectsDir)) {
			for (const objEntry of readdirSync(objectsDir, { withFileTypes: true })) {
				if (!objEntry.isFile()) continue;
				const ext = normalizeSourceExt(extname(objEntry.name));
				if (!ext) continue;
				const dotIdx = objEntry.name.lastIndexOf(".");
				const hash = (dotIdx >= 0 ? objEntry.name.slice(0, dotIdx) : objEntry.name).toLowerCase();
				const fullPath = join(objectsDir, objEntry.name);
				if (referenced.has(hash)) {
					retainedCount++;
				} else {
					try {
						const sz = statSync(fullPath).size;
						unlinkSync(fullPath);
						deletedCount++;
						deletedBytes += sz;
						deletedHashes.push(hash);
					} catch {
						// ignore if concurrently removed
					}
				}
			}
		}

		return { deletedCount, deletedBytes, retainedCount, deletedHashes };
	});
}
