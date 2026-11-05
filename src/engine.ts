import { basename, extname } from "node:path";
import { statSync } from "node:fs";
import { chunkDocumentPages } from "./chunker.ts";
import { defaultRealkbDir, loadConfig, type RealkbConfig } from "./config.ts";
import { type ChunkSearchHit, KbSearchIndex, type StoredChunkRow } from "./db.ts";
import { Embedder, sha256Text } from "./embedder.ts";
import { withFileLock } from "./lock.ts";
import { extractPdfPages, extractTextPages } from "./pdf.ts";
import {
	assignShortHash,
	ensureSharedOriginalPdf,
	ensureStorageDirs,
	formatCitation,
	formatPdfFileUrl,
	hashFileSha256,
	inspectImportPaths,
	kbIndexDbPath,
	type KbMeta,
	listKbs,
	loadSourceMeta,
	loadSourcePages,
	normalizeSourceExt,
	objectPdfPath,
	type PagesData,
	parseReference,
	resolveKb,
	resolveSourceInKb,
	saveSourceMeta,
	saveSourcePages,
	type SourceMeta,
	type SupportedSourceExt,
} from "./storage.ts";

export interface DocumentImportOutcome {
	inputPath: string;
	filename: string;
	fullHash?: string;
	shortHash?: string;
	citation?: string;
	outcome: "ready" | "already_imported" | "failed";
	failingStep?: "extract" | "chunk" | "embed" | "index";
	reason?: string;
	pageCount?: number;
	usableTextPages?: number;
	unreadablePages?: number[];
	figureCount?: number;
	chunkCount?: number;
	reusedExtraction?: boolean;
}

export interface BatchImportResult {
	kb: KbMeta;
	ready: DocumentImportOutcome[];
	alreadyImported: DocumentImportOutcome[];
	failed: DocumentImportOutcome[];
	outcomes: DocumentImportOutcome[];
}

export type ImportStage =
	| "queued"
	| "extracting"
	| "chunking"
	| "embedding"
	| "indexing"
	| "file_done"
	| "completed";

export interface ImportProgressEvent {
	kbId: string;
	kbName: string;
	fileIndex: number;
	totalFiles: number;
	filename: string;
	stage: ImportStage;
	pageCount?: number;
	totalChunks?: number;
	cachedChunks?: number;
	embeddedChunks?: number;
	readyCount: number;
	skippedCount: number;
	failedCount: number;
	message: string;
}

export interface SearchResultPassage {
	kbId: string;
	kbName: string;
	fullHash: string;
	shortHash: string;
	filename: string;
	chunkIndices: number[];
	pageStart: number;
	pageEnd: number;
	evidencePages: number[];
	citations: string[];
	documentCitation: string;
	pdfPath: string;
	pdfUrl: string;
	score: number;
	text: string;
}

export interface SearchExecutionResult {
	query: string;
	searchedKbs: KbMeta[];
	degradedToKeywordOnly: boolean;
	degradedReason?: string;
	warnings: string[];
	hits: SearchResultPassage[];
}

export interface ReadExecutionResult {
	kb: KbMeta;
	source: SourceMeta;
	mode: "chunks" | "pages";
	pdfPath: string;
	pdfUrl: string;
	documentCitation: string;
	citations: string[];
	passages: Array<{
		label: string;
		citation: string;
		pageStart: number;
		pageEnd: number;
		chunkIndex?: number;
		hasUsableText?: boolean;
		text: string;
	}>;
}

export interface SourceInfoResult {
	kb: KbMeta;
	source: SourceMeta;
	requestedPage?: number;
	citation: string;
	documentCitation: string;
	pdfPath: string;
	pdfUrl: string;
}

function mergeTextWithOverlap(firstText: string, secondText: string): string {
	const maxCheck = Math.min(firstText.length, secondText.length, 800);
	for (let len = maxCheck; len >= 24; len--) {
		const suffix = firstText.slice(firstText.length - len);
		if (secondText.startsWith(suffix)) {
			return `${firstText}${secondText.slice(len)}`;
		}
	}
	return `${firstText}\n\n${secondText}`;
}

function deduplicateAndMergeAdjacentHits(
	rawHits: Array<{ kb: KbMeta; hit: ChunkSearchHit }>,
	rootDir: string,
	limit: number,
): SearchResultPassage[] {
	const out: SearchResultPassage[] = [];
	const bySourceChunk = new Map<string, number>();

	for (const { kb, hit } of rawHits) {
		const ch = hit.chunk;
		const key = `${kb.id}:${ch.fullHash}:${ch.chunkIndex}`;
		if (bySourceChunk.has(key)) continue;

		const prevKey = `${kb.id}:${ch.fullHash}:${ch.chunkIndex - 1}`;
		const nextKey = `${kb.id}:${ch.fullHash}:${ch.chunkIndex + 1}`;
		const existingIdx = bySourceChunk.get(prevKey) ?? bySourceChunk.get(nextKey);

		if (existingIdx !== undefined) {
			const existing = out[existingIdx];
			if (existing && existing.chunkIndices.length < 2) {
				const isAfter = ch.chunkIndex > existing.chunkIndices[existing.chunkIndices.length - 1];
				existing.text = isAfter
					? mergeTextWithOverlap(existing.text, ch.text)
					: mergeTextWithOverlap(ch.text, existing.text);
				existing.chunkIndices = [...existing.chunkIndices, ch.chunkIndex].sort((a, b) => a - b);
				existing.pageStart = Math.min(existing.pageStart, ch.pageStart);
				existing.pageEnd = Math.max(existing.pageEnd, ch.pageEnd);
				const mergedPages = new Set<number>([...existing.evidencePages, ...hit.evidencePages]);
				existing.evidencePages = [...mergedPages].sort((a, b) => a - b);
				existing.citations = existing.evidencePages.map((p) => formatCitation(kb.id, ch.shortHash, p));
				existing.score = Math.max(existing.score, hit.score);
				bySourceChunk.set(key, existingIdx);
				continue;
			}
		}

		const evidencePages =
			hit.evidencePages.length > 0 ? hit.evidencePages : [ch.pageStart];
		const citations = evidencePages.map((p) => formatCitation(kb.id, ch.shortHash, p));
		const passage: SearchResultPassage = {
			kbId: kb.id,
			kbName: kb.name,
			fullHash: ch.fullHash,
			shortHash: ch.shortHash,
			filename: ch.filename,
			chunkIndices: [ch.chunkIndex],
			pageStart: ch.pageStart,
			pageEnd: ch.pageEnd,
			evidencePages,
			citations,
			documentCitation: formatCitation(kb.id, ch.shortHash),
			pdfPath: objectPdfPath(rootDir, ch.fullHash),
			pdfUrl: formatPdfFileUrl(rootDir, ch.fullHash, evidencePages[0]),
			score: hit.score,
			text: ch.text,
		};
		const newIdx = out.length;
		out.push(passage);
		bySourceChunk.set(key, newIdx);
		if (out.length >= limit) break;
	}

	return out;
}

async function importSinglePdfLocked(params: {
	rootDir: string;
	kb: KbMeta;
	inputPath: string;
	fileIndex: number;
	totalFiles: number;
	counts: { ready: number; skipped: number; failed: number };
	embedder: Embedder;
	index: KbSearchIndex;
	signal?: AbortSignal;
	onProgress?: (event: ImportProgressEvent) => void;
}): Promise<DocumentImportOutcome> {
	const { rootDir, kb, inputPath, fileIndex, totalFiles, counts, embedder, index, signal, onProgress } = params;
	const filename = basename(inputPath);
	const fingerprint = embedder.fingerprint;
	const emit = (
		stage: ImportStage,
		message: string,
		extra?: Partial<
			Pick<ImportProgressEvent, "pageCount" | "totalChunks" | "cachedChunks" | "embeddedChunks">
		>,
	): void => {
		onProgress?.({
			kbId: kb.id,
			kbName: kb.name,
			fileIndex,
			totalFiles,
			filename,
			stage,
			readyCount: counts.ready,
			skippedCount: counts.skipped,
			failedCount: counts.failed,
			message,
			...extra,
		});
	};

	let fullHash: string;
	let fileSize: number;
	try {
		const hashed = hashFileSha256(inputPath);
		fullHash = hashed.fullHash;
		fileSize = statSync(inputPath).size;
	} catch (err) {
		return {
			inputPath,
			filename,
			outcome: "failed",
			failingStep: "extract",
			reason: `Could not read input PDF: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const shortHash = assignShortHash(rootDir, kb.id, fullHash);
	const citation = formatCitation(kb.id, shortHash);
	const existing = loadSourceMeta(rootDir, kb.id, fullHash);
	const sourceType: SupportedSourceExt = normalizeSourceExt(extname(inputPath)) ?? "pdf";
	const objectRelPath = `objects/${fullHash}.${sourceType}`;

	// Skip already-successful duplicates in the same KB when embedding fingerprint matches.
	if (
		existing &&
		existing.status === "ready" &&
		existing.embeddingFingerprint === fingerprint &&
		index.getChunksForSource(fullHash).length > 0
	) {
		return {
			inputPath,
			filename: existing.originalFilename || filename,
			fullHash,
			shortHash: existing.shortHash,
			citation: formatCitation(kb.id, existing.shortHash),
			outcome: "already_imported",
			pageCount: existing.pageCount,
			usableTextPages: existing.usableTextPages,
			unreadablePages: existing.unreadablePages,
			figureCount: existing.figureCount,
			chunkCount: existing.chunkCount,
		};
	}

	// Ensure shared original source file in objects/<fullHash>.<ext>
	let storedPdfPath: string;
	try {
		storedPdfPath = ensureSharedOriginalPdf(rootDir, fullHash, inputPath, sourceType);
	} catch (err) {
		return {
			inputPath,
			filename,
			fullHash,
			shortHash,
			citation,
			outcome: "failed",
			failingStep: "extract",
			reason: `Failed to store shared original file: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const nowIso = new Date().toISOString();
	const importedAt = existing?.importedAt ?? nowIso;

	// Reuse completed extraction from pages.json if available on retry
	let pagesData: PagesData | undefined = loadSourcePages(rootDir, kb.id, fullHash);
	let reusedExtraction = false;

	if (pagesData && pagesData.fullHash === fullHash && pagesData.pages.length > 0) {
		reusedExtraction = true;
		emit("extracting", `[${fileIndex}/${totalFiles}] ${filename}: reusing extracted pages (${pagesData.pageCount}p)`, {
			pageCount: pagesData.pageCount,
		});
	} else {
		emit("extracting", `[${fileIndex}/${totalFiles}] ${filename}: extracting text…`);
		const extractingMeta: SourceMeta = {
			fullHash,
			shortHash,
			originalFilename: filename,
			originalPath: inputPath,
			objectRelPath,
			sourceType,
			fileSize,
			importedAt,
			updatedAt: new Date().toISOString(),
			status: "extracting",
			pageCount: 0,
			usableTextPages: 0,
			unreadablePages: [],
			figureCount: 0,
		};
		saveSourceMeta(rootDir, kb.id, extractingMeta);

		try {
			pagesData =
				sourceType === "pdf"
					? await extractPdfPages(storedPdfPath, fullHash)
					: extractTextPages(storedPdfPath, fullHash);
			saveSourcePages(rootDir, kb.id, pagesData);
		} catch (err) {
			const reason = `Text extraction failed: ${err instanceof Error ? err.message : String(err)}`;
			saveSourceMeta(rootDir, kb.id, {
				...extractingMeta,
				updatedAt: new Date().toISOString(),
				status: "failed",
				failingStep: "extract",
				error: reason,
			});
			return {
				inputPath,
				filename,
				fullHash,
				shortHash,
				citation,
				outcome: "failed",
				failingStep: "extract",
				reason,
			};
		}
	}

	const pageCount = pagesData.pageCount;
	const unreadablePages = pagesData.pages.filter((p) => !p.hasUsableText).map((p) => p.pageNumber);
	const usableTextPages = pageCount - unreadablePages.length;
	const figureCount = pagesData.pages.reduce((acc, p) => acc + p.figureMarkers.length, 0);

	if (usableTextPages <= 0) {
		const reason =
			sourceType === "pdf"
				? "No usable selectable text could be extracted from any page (document appears scanned or image-only; V1 does not perform OCR)."
				: `No usable text could be extracted from .${sourceType} file (file appears empty).`;
		saveSourceMeta(rootDir, kb.id, {
			fullHash,
			shortHash,
			originalFilename: filename,
			originalPath: inputPath,
			objectRelPath,
			sourceType,
			fileSize,
			importedAt,
			updatedAt: new Date().toISOString(),
			status: "failed",
			failingStep: "extract",
			error: reason,
			pageCount,
			usableTextPages,
			unreadablePages,
			figureCount,
		});
		return {
			inputPath,
			filename,
			fullHash,
			shortHash,
			citation,
			outcome: "failed",
			failingStep: "extract",
			reason,
			pageCount,
			usableTextPages,
			unreadablePages,
			figureCount,
			reusedExtraction,
		};
	}

	const extractedMeta: SourceMeta = {
		fullHash,
		shortHash,
		originalFilename: filename,
		originalPath: inputPath,
		objectRelPath,
		sourceType,
		fileSize,
		importedAt,
		updatedAt: new Date().toISOString(),
		status: "extracted",
		pageCount,
		usableTextPages,
		unreadablePages,
		figureCount,
	};
	saveSourceMeta(rootDir, kb.id, extractedMeta);

	// Step 2: Chunk extracted pages
	emit("chunking", `[${fileIndex}/${totalFiles}] ${filename}: chunking ${pageCount} page(s)…`, {
		pageCount,
	});
	const chunks = chunkDocumentPages(pagesData);
	if (chunks.length === 0) {
		const reason = "No indexable text chunks could be constructed from the extracted pages.";
		saveSourceMeta(rootDir, kb.id, {
			...extractedMeta,
			updatedAt: new Date().toISOString(),
			status: "failed",
			failingStep: "chunk",
			error: reason,
		});
		return {
			inputPath,
			filename,
			fullHash,
			shortHash,
			citation,
			outcome: "failed",
			failingStep: "chunk",
			reason,
			pageCount,
			usableTextPages,
			unreadablePages,
			figureCount,
			reusedExtraction,
		};
	}

	// Step 3: Check embedding configuration & compatibility
	if (!embedder.configured) {
		const reason =
			"Embedding API is not configured (~/.pi/agent/realkb/config.json). Extraction was saved and will be reused when retried.";
		saveSourceMeta(rootDir, kb.id, {
			...extractedMeta,
			updatedAt: new Date().toISOString(),
			status: "failed",
			failingStep: "embed",
			error: reason,
		});
		return {
			inputPath,
			filename,
			fullHash,
			shortHash,
			citation,
			outcome: "failed",
			failingStep: "embed",
			reason,
			pageCount,
			usableTextPages,
			unreadablePages,
			figureCount,
			reusedExtraction,
		};
	}

	const compat = index.checkFingerprintCompatibility(fingerprint);
	if (!compat.compatible) {
		const reason = `KB ${kb.id} already contains vectors indexed with "${compat.storedFingerprint}", which is incompatible with the current embedding configuration "${fingerprint}".`;
		saveSourceMeta(rootDir, kb.id, {
			...extractedMeta,
			updatedAt: new Date().toISOString(),
			status: "failed",
			failingStep: "embed",
			error: reason,
		});
		return {
			inputPath,
			filename,
			fullHash,
			shortHash,
			citation,
			outcome: "failed",
			failingStep: "embed",
			reason,
			pageCount,
			usableTextPages,
			unreadablePages,
			figureCount,
			reusedExtraction,
		};
	}

	saveSourceMeta(rootDir, kb.id, {
		...extractedMeta,
		updatedAt: new Date().toISOString(),
		status: "indexing",
	});

	// Reuse cached chunk vectors where available; embed only missing chunks.
	const vectors: Array<Float32Array | undefined> = new Array(chunks.length);
	const missingIndices: number[] = [];
	const missingTexts: string[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const textHash = sha256Text(chunks[i].text);
		const cached = index.getCachedEmbedding(textHash, fingerprint);
		if (cached && cached.length === embedder.dimensions) {
			vectors[i] = cached;
		} else {
			missingIndices.push(i);
			missingTexts.push(chunks[i].text);
		}
	}

	const cachedCount = chunks.length - missingTexts.length;
	emit(
		"embedding",
		`[${fileIndex}/${totalFiles}] ${filename}: embedding ${cachedCount}/${chunks.length} chunks (${Math.round((cachedCount / chunks.length) * 100)}%)`,
		{
			pageCount,
			totalChunks: chunks.length,
			cachedChunks: cachedCount,
			embeddedChunks: cachedCount,
		},
	);

	if (missingTexts.length > 0) {
		try {
			await embedder.embedTexts(
				missingTexts,
				"document",
				signal,
				(batchVectors, batchStartIndex, completedCount) => {
					for (let k = 0; k < batchVectors.length; k++) {
						const chunkIdx = missingIndices[batchStartIndex + k];
						const vec = batchVectors[k];
						vectors[chunkIdx] = vec;
						// Immediately persist to embedding cache so partial progress survives any later error
						index.putCachedEmbedding(sha256Text(chunks[chunkIdx].text), fingerprint, vec);
					}
					const doneChunks = cachedCount + completedCount;
					const pct = Math.round((doneChunks / chunks.length) * 100);
					emit(
						"embedding",
						`[${fileIndex}/${totalFiles}] ${filename}: embedding ${doneChunks}/${chunks.length} chunks (${pct}%)`,
						{
							pageCount,
							totalChunks: chunks.length,
							cachedChunks: cachedCount,
							embeddedChunks: doneChunks,
						},
					);
				},
			);
		} catch (err) {
			const reason = `Embedding failed: ${err instanceof Error ? err.message : String(err)}`;
			saveSourceMeta(rootDir, kb.id, {
				...extractedMeta,
				updatedAt: new Date().toISOString(),
				status: "failed",
				failingStep: "embed",
				error: reason,
			});
			return {
				inputPath,
				filename,
				fullHash,
				shortHash,
				citation,
				outcome: "failed",
				failingStep: "embed",
				reason,
				pageCount,
				usableTextPages,
				unreadablePages,
				figureCount,
				reusedExtraction,
			};
		}
	}

	// Step 4: Index chunks, FTS, and vectors in search.sqlite
	emit("indexing", `[${fileIndex}/${totalFiles}] ${filename}: indexing ${chunks.length} chunks…`, {
		pageCount,
		totalChunks: chunks.length,
		cachedChunks: cachedCount,
		embeddedChunks: chunks.length,
	});
	try {
		index.indexDocumentChunks({
			fullHash,
			shortHash,
			filename,
			chunks,
			vectors: vectors as Float32Array[],
			fingerprint,
		});
	} catch (err) {
		const reason = `Database indexing failed: ${err instanceof Error ? err.message : String(err)}`;
		saveSourceMeta(rootDir, kb.id, {
			...extractedMeta,
			updatedAt: new Date().toISOString(),
			status: "failed",
			failingStep: "index",
			error: reason,
		});
		return {
			inputPath,
			filename,
			fullHash,
			shortHash,
			citation,
			outcome: "failed",
			failingStep: "index",
			reason,
			pageCount,
			usableTextPages,
			unreadablePages,
			figureCount,
			reusedExtraction,
		};
	}

	const readyMeta: SourceMeta = {
		...extractedMeta,
		updatedAt: new Date().toISOString(),
		status: "ready",
		failingStep: undefined,
		error: undefined,
		chunkCount: chunks.length,
		embeddingFingerprint: fingerprint,
	};
	saveSourceMeta(rootDir, kb.id, readyMeta);

	return {
		inputPath,
		filename,
		fullHash,
		shortHash,
		citation,
		outcome: "ready",
		pageCount,
		usableTextPages,
		unreadablePages,
		figureCount,
		chunkCount: chunks.length,
		reusedExtraction,
	};
}

/**
 * Validate input paths (requiring PDF-only directory contents after skipping dot-entries)
 * and run a queued batch import into an explicit target KB.
 */
export async function importPdfsToKb(params: {
	kbIdOrName: string;
	paths: string[];
	cwd: string;
	allowExt?: string[];
	rootDir?: string;
	config?: RealkbConfig;
	embedder?: Embedder;
	signal?: AbortSignal;
	onProgress?: (event: ImportProgressEvent) => void;
}): Promise<BatchImportResult> {
	const rootDir = params.rootDir ?? defaultRealkbDir();
	ensureStorageDirs(rootDir);

	const kb = resolveKb(rootDir, params.kbIdOrName);
	if (!kb) {
		throw new Error(`Knowledge base "${params.kbIdOrName}" was not found.`);
	}
	if (!Array.isArray(params.paths) || params.paths.length === 0) {
		throw new Error("At least one file or directory path is required.");
	}

	const inspection = inspectImportPaths(params.paths, params.cwd, params.allowExt);
	if (inspection.missingPaths.length > 0) {
		throw new Error(`Path(s) not found: ${inspection.missingPaths.join(", ")}`);
	}
	if (inspection.unexpectedFiles.length > 0) {
		const details = inspection.unexpectedFiles
			.slice(0, 15)
			.map((u) => `${u.filePath} (${u.reason})`)
			.join("; ");
		const more =
			inspection.unexpectedFiles.length > 15
				? ` (+${inspection.unexpectedFiles.length - 15} more)`
				: "";
		throw new Error(
			`Refusing to import mixed or non-PDF contents. Inspect and clean up unexpected files first: ${details}${more}`,
		);
	}
	if (inspection.validPdfFiles.length === 0) {
		throw new Error("No PDF files were found in the specified path(s).");
	}

	const config = params.config ?? loadConfig(rootDir);
	const embedder = params.embedder ?? new Embedder(config);

	return withFileLock(
		rootDir,
		"import",
		async () => {
			const index = new KbSearchIndex(kbIndexDbPath(rootDir, kb.id));
			try {
				const outcomes: DocumentImportOutcome[] = [];
				const counts = { ready: 0, skipped: 0, failed: 0 };
				const totalFiles = inspection.validPdfFiles.length;

				for (let i = 0; i < totalFiles; i++) {
					if (params.signal?.aborted) {
						throw new Error("Import aborted");
					}
					const pdfPath = inspection.validPdfFiles[i];
					const outcome = await importSinglePdfLocked({
						rootDir,
						kb,
						inputPath: pdfPath,
						fileIndex: i + 1,
						totalFiles,
						counts,
						embedder,
						index,
						signal: params.signal,
						onProgress: params.onProgress,
					});
					outcomes.push(outcome);
					if (outcome.outcome === "ready") counts.ready++;
					else if (outcome.outcome === "already_imported") counts.skipped++;
					else counts.failed++;

					let outcomeShort = `failed (${outcome.failingStep ?? "error"})`;
					if (outcome.outcome === "ready") {
						outcomeShort = `ready (${outcome.chunkCount ?? 0} chunks)`;
					} else if (outcome.outcome === "already_imported") {
						outcomeShort = "already imported";
					}

					params.onProgress?.({
						kbId: kb.id,
						kbName: kb.name,
						fileIndex: i + 1,
						totalFiles,
						filename: outcome.filename,
						stage: "file_done",
						pageCount: outcome.pageCount,
						totalChunks: outcome.chunkCount,
						embeddedChunks: outcome.chunkCount,
						readyCount: counts.ready,
						skippedCount: counts.skipped,
						failedCount: counts.failed,
						message: `[${i + 1}/${totalFiles}] ${outcome.filename}: ${outcomeShort}`,
					});
				}

				params.onProgress?.({
					kbId: kb.id,
					kbName: kb.name,
					fileIndex: totalFiles,
					totalFiles,
					filename: "",
					stage: "completed",
					readyCount: counts.ready,
					skippedCount: counts.skipped,
					failedCount: counts.failed,
					message: `Completed: ${counts.ready} ready, ${counts.skipped} skipped, ${counts.failed} failed`,
				});

				return {
					kb,
					ready: outcomes.filter((o) => o.outcome === "ready"),
					alreadyImported: outcomes.filter((o) => o.outcome === "already_imported"),
					failed: outcomes.filter((o) => o.outcome === "failed"),
					outcomes,
				};
			} finally {
				index.close();
			}
		},
		{ ttlMs: 300_000, waitMs: 120_000 },
	);
}

/**
 * Search across session-connected KBs (or an explicit subset of connected KBs)
 * using hybrid vector (`sqlite-vec`) + keyword (`FTS5`) retrieval.
 * Falls back to keyword search with explicit disclosure if query embedding fails.
 */
export async function searchConnectedKbs(params: {
	query: string;
	connectedKbIds: string[];
	filterKbIds?: string[];
	limit?: number;
	rootDir?: string;
	config?: RealkbConfig;
	embedder?: Embedder;
	signal?: AbortSignal;
}): Promise<SearchExecutionResult> {
	const rootDir = params.rootDir ?? defaultRealkbDir();
	const query = params.query.trim();
	if (!query) {
		throw new Error("Search query must not be empty.");
	}
	if (params.connectedKbIds.length === 0) {
		throw new Error(
			"No knowledge bases are connected to this session. Connect a KB first with realkb_connect or /realkb connect.",
		);
	}

	const connectedSet = new Set(params.connectedKbIds);
	const allKbs = listKbs(rootDir);
	const byId = new Map(allKbs.map((k) => [k.id, k]));

	let targetKbIds = [...connectedSet];
	if (params.filterKbIds && params.filterKbIds.length > 0) {
		const resolvedFilterIds: string[] = [];
		for (const raw of params.filterKbIds) {
			const kb = resolveKb(rootDir, raw);
			if (!kb) {
				throw new Error(`Knowledge base "${raw}" does not exist.`);
			}
			if (!connectedSet.has(kb.id)) {
				throw new Error(
					`Knowledge base ${kb.id} ("${kb.name}") is not connected to this session. Only connected KBs can be searched.`,
				);
			}
			if (!resolvedFilterIds.includes(kb.id)) {
				resolvedFilterIds.push(kb.id);
			}
		}
		targetKbIds = resolvedFilterIds;
	}

	const searchedKbs = targetKbIds
		.map((id) => byId.get(id))
		.filter((k): k is KbMeta => Boolean(k));
	if (searchedKbs.length === 0) {
		throw new Error("None of the connected knowledge bases exist on disk.");
	}

	const config = params.config ?? loadConfig(rootDir);
	const embedder = params.embedder ?? new Embedder(config);
	const fingerprint = embedder.fingerprint;
	const limit = Math.max(1, Math.min(30, params.limit ?? 8));

	let queryVec: Float32Array | undefined;
	let degradedToKeywordOnly = false;
	let degradedReason: string | undefined;
	const warnings: string[] = [];

	// Try to reuse cached query embedding or call the embedding API once for the query
	const queryCacheKey = sha256Text(`query:${config.embedding.queryInstruction}:${query}`);
	if (embedder.configured) {
		for (const kb of searchedKbs) {
			const idx = new KbSearchIndex(kbIndexDbPath(rootDir, kb.id));
			try {
				const cached = idx.getCachedEmbedding(queryCacheKey, fingerprint);
				if (cached && cached.length === embedder.dimensions) {
					queryVec = cached;
					break;
				}
			} finally {
				idx.close();
			}
		}
		if (!queryVec) {
			try {
				const [fresh] = await embedder.embedTexts([query], "query", params.signal);
				queryVec = fresh;
				// Cache the query vector in the first searched KB
				const firstIdx = new KbSearchIndex(kbIndexDbPath(rootDir, searchedKbs[0].id));
				try {
					firstIdx.putCachedEmbedding(queryCacheKey, fingerprint, fresh);
				} finally {
					firstIdx.close();
				}
			} catch (err) {
				degradedToKeywordOnly = true;
				degradedReason = `Meaning-based vector search was unavailable (${err instanceof Error ? err.message : String(err)}); showing keyword search results only.`;
				warnings.push(degradedReason);
			}
		}
	} else {
		degradedToKeywordOnly = true;
		degradedReason =
			"Embedding API is not configured; showing keyword search results only.";
		warnings.push(degradedReason);
	}

	const rawHits: Array<{ kb: KbMeta; hit: ChunkSearchHit }> = [];

	for (const kb of searchedKbs) {
		const idx = new KbSearchIndex(kbIndexDbPath(rootDir, kb.id));
		try {
			const compat = idx.checkFingerprintCompatibility(fingerprint);
			let kbQueryVec = queryVec;
			if (!compat.compatible) {
				warnings.push(
					`KB ${kb.id} ("${kb.name}") was indexed with a different embedding model/config (${compat.storedFingerprint}); using keyword search only for this KB.`,
				);
				kbQueryVec = undefined;
			}
			const kbHits = idx.hybridSearch({
				queryText: query,
				queryVec: kbQueryVec,
				fingerprint: kbQueryVec ? fingerprint : undefined,
				limit: limit * 2,
			});
			for (const h of kbHits) {
				rawHits.push({ kb, hit: h });
			}
		} finally {
			idx.close();
		}
	}

	rawHits.sort((a, b) => b.hit.score - a.hit.score);
	const mergedPassages = deduplicateAndMergeAdjacentHits(rawHits, rootDir, limit);

	return {
		query,
		searchedKbs,
		degradedToKeywordOnly,
		degradedReason,
		warnings,
		hits: mergedPassages,
	};
}

/**
 * Read a passage (chunk + surrounding `± neighbors` chunks) or a PDF page / page range
 * from a connected KB.
 */
export function readFromKb(params: {
	ref: string;
	connectedKbIds: string[];
	chunk?: number;
	neighbors?: number;
	pageStart?: number;
	pageEnd?: number;
	rootDir?: string;
}): ReadExecutionResult {
	const rootDir = params.rootDir ?? defaultRealkbDir();
	const parsed = parseReference(params.ref);
	if (!parsed) {
		throw new Error(
			`Invalid reference "${params.ref}". Expected format like "001_c676ea9p7", "[rkb:001_c676ea9p7]", or "001:c676ea9".`,
		);
	}

	const connectedSet = new Set(params.connectedKbIds);
	if (!connectedSet.has(parsed.kbId)) {
		throw new Error(
			`Knowledge base ${parsed.kbId} is not connected to this session. Connect it first with realkb_connect or /realkb connect.`,
		);
	}

	const kb = resolveKb(rootDir, parsed.kbId);
	if (!kb) {
		throw new Error(`Knowledge base ${parsed.kbId} was not found.`);
	}

	const source = resolveSourceInKb(rootDir, kb.id, parsed.sourceHash);
	if (!source) {
		throw new Error(`Source "${parsed.sourceHash}" was not found in KB ${kb.id} ("${kb.name}").`);
	}

	const documentCitation = formatCitation(kb.id, source.shortHash);
	const pdfPath = objectPdfPath(rootDir, source.fullHash);

	// Mode 1: Chunk read (`chunk` index specified)
	if (params.chunk !== undefined) {
		const neighbors = Math.max(0, Math.min(5, Math.trunc(params.neighbors ?? 1)));
		const idx = new KbSearchIndex(kbIndexDbPath(rootDir, kb.id));
		let rows: StoredChunkRow[];
		try {
			rows = idx.getChunkWindow(source.fullHash, Math.trunc(params.chunk), neighbors);
		} finally {
			idx.close();
		}
		if (rows.length === 0) {
			throw new Error(
				`Chunk ${params.chunk} was not found in source ${documentCitation} ("${source.originalFilename}").`,
			);
		}
		const citationSet = new Set<string>();
		const passages = rows.map((r) => {
			for (const p of r.pages) {
				citationSet.add(formatCitation(kb.id, source.shortHash, p));
			}
			const primaryCitation = formatCitation(kb.id, source.shortHash, r.pageStart);
			const pageLabel =
				r.pageStart === r.pageEnd ? `p.${r.pageStart}` : `pp.${r.pageStart}-${r.pageEnd}`;
			return {
				label: `Chunk #${r.chunkIndex} (${pageLabel})`,
				citation: primaryCitation,
				pageStart: r.pageStart,
				pageEnd: r.pageEnd,
				chunkIndex: r.chunkIndex,
				text: r.text,
			};
		});

		const firstPage = rows[0].pageStart;
		return {
			kb,
			source,
			mode: "chunks",
			pdfPath,
			pdfUrl: formatPdfFileUrl(rootDir, source.fullHash, firstPage),
			documentCitation,
			citations: [...citationSet],
			passages,
		};
	}

	// Mode 2: Page / page-range read
	const pagesData = loadSourcePages(rootDir, kb.id, source.fullHash);
	if (!pagesData || pagesData.pages.length === 0) {
		throw new Error(
			`Extracted page text is not available for ${documentCitation} ("${source.originalFilename}").`,
		);
	}

	const startPage = params.pageStart ?? parsed.page ?? 1;
	const endPage = params.pageEnd ?? (parsed.page !== undefined ? parsed.page : Math.min(pagesData.pageCount, startPage + 2));
	if (startPage < 1 || startPage > pagesData.pageCount) {
		throw new Error(
			`Requested page ${startPage} is out of range (document has ${pagesData.pageCount} page(s)).`,
		);
	}
	const clampedEnd = Math.max(startPage, Math.min(pagesData.pageCount, Math.min(endPage, startPage + 9)));

	const citations: string[] = [];
	const passages: ReadExecutionResult["passages"] = [];

	for (let p = startPage; p <= clampedEnd; p++) {
		const pageEntry = pagesData.pages.find((pg) => pg.pageNumber === p);
		const cit = formatCitation(kb.id, source.shortHash, p);
		citations.push(cit);
		passages.push({
			label: `Page ${p} of ${pagesData.pageCount}`,
			citation: cit,
			pageStart: p,
			pageEnd: p,
			hasUsableText: pageEntry?.hasUsableText ?? false,
			text:
				pageEntry && pageEntry.text.trim()
					? pageEntry.text
					: "(No usable selectable text on this page; consult the original PDF.)",
		});
	}

	return {
		kb,
		source,
		mode: "pages",
		pdfPath,
		pdfUrl: formatPdfFileUrl(rootDir, source.fullHash, startPage),
		documentCitation,
		citations,
		passages,
	};
}

/**
 * Resolve a specific source reference (`001_c676ea9`, `[rkb:001_c676ea9p7]`, or `001:c676ea9`)
 * and return its metadata and original PDF location.
 * Per confirmed V1 design, resolving an explicit source reference works even if the KB is not
 * currently connected, without connecting the KB or granting search/read access.
 */
export function getSourceInfo(ref: string, rootDir = defaultRealkbDir()): SourceInfoResult {
	const parsed = parseReference(ref);
	if (!parsed) {
		throw new Error(
			`Invalid source reference "${ref}". Expected format like "001_c676ea9", "[rkb:001_c676ea9p7]", or "001:c676ea9".`,
		);
	}
	const kb = resolveKb(rootDir, parsed.kbId);
	if (!kb) {
		throw new Error(`Knowledge base ${parsed.kbId} was not found.`);
	}
	const source = resolveSourceInKb(rootDir, kb.id, parsed.sourceHash);
	if (!source) {
		throw new Error(`Source "${parsed.sourceHash}" was not found in KB ${kb.id} ("${kb.name}").`);
	}
	const documentCitation = formatCitation(kb.id, source.shortHash);
	const citation = formatCitation(kb.id, source.shortHash, parsed.page);
	const pdfPath = objectPdfPath(rootDir, source.fullHash);
	const pdfUrl = formatPdfFileUrl(rootDir, source.fullHash, parsed.page);

	return {
		kb,
		source,
		requestedPage: parsed.page,
		citation,
		documentCitation,
		pdfPath,
		pdfUrl,
	};
}

/**
 * Transform bare `[rkb:001_c676ea9]` and `[rkb:001_c676ea9p7]` (or `[rkb:1_c676ea9p7]`) citations
 * in Markdown text into compact clickable Markdown links (`[[1:c676ea9,p7]](file:///.../objects/<hash>.pdf#page=7)`)
 * for Pi's interactive TUI frontend, while skipping fenced code blocks, inline code spans, and citations
 * already inside a Markdown link.
 *
 * Registered via `pi.registerMarkdownTransformer`, so it runs only when rendering Markdown in the UI
 * and never mutates the LLM context or session transcript.
 */
export function linkifyCitationsInMarkdown(markdown: string, rootDir = defaultRealkbDir()): string {
	if (!markdown.includes("[rkb:")) return markdown;

	// Split out fenced code blocks and inline code spans so we never modify code.
	const protectedSegments = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
	const citationRe = /(?<!\[)\[rkb:(\d+)_([0-9a-fA-F]{7,64})(?:p([1-9]\d*))?\](?!\()/g;

	for (let i = 0; i < protectedSegments.length; i += 2) {
		protectedSegments[i] = protectedSegments[i].replace(
			citationRe,
			(fullMatch, rawKbId: string, rawHash: string, rawPage?: string) => {
				try {
					const kb = resolveKb(rootDir, rawKbId);
					if (!kb) return fullMatch;
					const src = resolveSourceInKb(rootDir, kb.id, rawHash);
					if (!src) return fullMatch;
					const page = rawPage ? Number.parseInt(rawPage, 10) : undefined;
					const url = formatPdfFileUrl(rootDir, src.fullHash, page);
					const kbDisplay = Number.parseInt(kb.id, 10);
					const label =
						page !== undefined
							? `${kbDisplay}:${src.shortHash},p${page}`
							: `${kbDisplay}:${src.shortHash}`;
					return `[[${label}]](${url})`;
				} catch {
					return fullMatch;
				}
			},
		);
	}

	return protectedSegments.join("");
}
