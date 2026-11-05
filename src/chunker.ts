import type { ExtractedPage, PagesData } from "./storage.ts";

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LIST_ITEM_RE = /^(?:[-*•◦▪▸]|\(?[0-9]{1,3}[.)]|\([a-zA-Z]\)|[ivxIVX]{1,5}\.)\s+/;
const HEADING_NUMBERED_RE = /^(?:(?:chapter|section|part|appendix)\s+[0-9a-zA-Z]+|[0-9]+(?:\.[0-9]+){0,3}\s+[A-Z\p{Script=Han}])/iu;
const TERMINAL_PUNCT_RE = /[.?!。？！:：;；"”’)\]]\s*$/;
const ABBREV_END_RE = /\b(?:e\.g|i\.e|fig|figs|dr|mr|mrs|ms|prof|et\s+al|vs|no|nos|vol|vols|p|pp|sec|secs|eq|eqs|ch|cf|inc|ltd|co|st|jr|sr)\.\s*$/i;

/** Common compound prefixes where a line-break hyphen should be preserved (`self-contained`, `non-empty`, etc.). */
const COMPOUND_PREFIXES = new Set([
	"self",
	"non",
	"well",
	"cross",
	"co",
	"counter",
	"anti",
	"multi",
	"inter",
	"intra",
	"quasi",
	"semi",
	"sub",
	"super",
	"ultra",
	"over",
	"under",
	"pre",
	"post",
	"re",
	"ex",
	"all",
	"half",
	"high",
	"low",
	"long",
	"short",
	"full",
	"part",
	"open",
	"closed",
	"free",
	"real",
	"single",
	"double",
	"triple",
	"first",
	"second",
	"third",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"state",
	"end",
	"fine",
	"large",
	"small",
]);

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export interface ChunkSpan {
	/** 1-based PDF page number. */
	page: number;
	/** Inclusive start character offset within `chunk.text`. */
	charStart: number;
	/** Exclusive end character offset within `chunk.text`. */
	charEnd: number;
}

export interface DocumentChunk {
	chunkIndex: number;
	pageStart: number;
	pageEnd: number;
	/** Sorted unique 1-based PDF page numbers that contributed text to this chunk. */
	pages: number[];
	text: string;
	tokenEstimate: number;
	spans: ChunkSpan[];
}

export interface ChunkingOptions {
	targetTokens?: number;
	minWindowTokens?: number;
	maxWindowTokens?: number;
	targetOverlapTokens?: number;
	minOverlapTokens?: number;
	maxOverlapTokens?: number;
}

interface SourcedSegment {
	text: string;
	page: number;
}

interface TextBlock {
	kind: "heading" | "paragraph" | "list";
	segments: SourcedSegment[];
	text: string;
	pageStart: number;
	pageEnd: number;
}

interface SentenceUnit {
	text: string;
	tokens: number;
	isHeading: boolean;
	blockIndex: number;
	/** Character-level page provenance inside `text`. */
	spans: ChunkSpan[];
}

/**
 * Conservative, model-agnostic token estimator:
 * - CJK characters count as 1 token each.
 * - Words/numbers/symbols are segmented with `Intl.Segmenter` and scaled so long words,
 *   identifiers, or URLs never underestimate provider limits.
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	let count = 0;
	for (const seg of wordSegmenter.segment(text)) {
		const s = seg.segment;
		if (!s.trim()) continue;
		if (CJK_RE.test(s)) {
			let cjkChars = 0;
			let otherChars = 0;
			for (const ch of s) {
				if (CJK_RE.test(ch)) cjkChars++;
				else otherChars++;
			}
			count += cjkChars + Math.ceil(otherChars / 3.5);
		} else if (seg.isWordLike) {
			count += Math.max(1, Math.ceil(s.length / 3.8));
		} else {
			count += Math.max(1, Math.ceil(s.length / 2));
		}
	}
	return Math.max(1, count);
}

function normalizeEdgeKey(line: string): string {
	return line
		.trim()
		.replace(/\b\d+\b/g, "#")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function isStandaloneEdgePageNumber(line: string, pageNumber: number, pageCount: number): boolean {
	const t = line.trim();
	if (!t) return false;
	if (/^(?:page|p\.?|第)\s*\d+(?:\s*(?:of|\/)\s*\d+|\s*页)?$/i.test(t)) return true;
	if (/^[-–—]\s*\d+\s*[-–—]$/.test(t)) return true;
	if (/^\d+\s*\/\s*\d+$/.test(t)) return true;
	if (pageCount >= 2 && /^\d{1,4}$/.test(t)) {
		const n = Number.parseInt(t, 10);
		if (n === pageNumber) return true;
	}
	return false;
}

/**
 * Detect repeating header and footer lines across pages so they can be stripped from the derived
 * chunking representation without modifying saved `pages.json`.
 */
function detectRepeatingHeadersAndFooters(pages: ExtractedPage[]): {
	headerKeys: Set<string>;
	footerKeys: Set<string>;
} {
	const headerKeys = new Set<string>();
	const footerKeys = new Set<string>();
	if (pages.length < 3) return { headerKeys, footerKeys };

	const topCounts = new Map<string, number>();
	const bottomCounts = new Map<string, number>();

	for (const page of pages) {
		const nonEmpty = page.text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !/^\[FIG p\d+-\d+\]$/.test(l));
		if (nonEmpty.length < 3) continue;
		const top = nonEmpty[0];
		const bottom = nonEmpty.at(-1)!;
		if (top.length <= 90) {
			const k = normalizeEdgeKey(top);
			if (k.length >= 3) topCounts.set(k, (topCounts.get(k) ?? 0) + 1);
		}
		if (bottom.length <= 90) {
			const k = normalizeEdgeKey(bottom);
			if (k.length >= 3) bottomCounts.set(k, (bottomCounts.get(k) ?? 0) + 1);
		}
	}

	const minRepeats = Math.max(3, Math.ceil(pages.length * 0.5));
	for (const [k, c] of topCounts) {
		if (c >= minRepeats) headerKeys.add(k);
	}
	for (const [k, c] of bottomCounts) {
		if (c >= minRepeats) footerKeys.add(k);
	}
	return { headerKeys, footerKeys };
}

/**
 * Decide how to join two wrapped lines inside a paragraph:
 * - De-hyphenate confidently identified line-break word splits (`inter-\nnational` -> `international`)
 * - Preserve compound hyphens (`self-\ncontained` -> `self-contained`, `UTF-\n8` -> `UTF-8`)
 * - Join CJK characters without spaces, and space-delimited scripts with a single space.
 */
export function joinWrappedLines(prevLine: string, nextLine: string): string {
	const left = prevLine.trimEnd();
	const right = nextLine.trimStart();
	if (!left) return right;
	if (!right) return left;

	const hyphenMatch = /([A-Za-z]{2,})-$/.exec(left);
	const rightWordMatch = /^([a-z]{2,})\b/.exec(right);
	if (hyphenMatch && rightWordMatch) {
		const prefix = hyphenMatch[1];
		const suffix = rightWordMatch[1];
		const lowerPrefix = prefix.toLowerCase();
		const isAllCapsPrefix = prefix === prefix.toUpperCase() && prefix !== prefix.toLowerCase();
		if (!isAllCapsPrefix && !COMPOUND_PREFIXES.has(lowerPrefix) && lowerPrefix.length + suffix.length >= 5) {
			// Confident word-break hyphenation across lines: remove hyphen and join directly.
			return `${left.slice(0, -1)}${right}`;
		}
		// Keep compound or uncertain hyphen without adding a space after `-`.
		return `${left}${right}`;
	}

	if (left.endsWith("-") && /^[A-Za-z0-9]/.test(right)) {
		return `${left}${right}`;
	}

	const lastChar = Array.from(left).at(-1) ?? "";
	const firstChar = Array.from(right)[0] ?? "";
	if (CJK_RE.test(lastChar) && CJK_RE.test(firstChar)) {
		return `${left}${right}`;
	}
	return `${left} ${right}`;
}

function isHeadingLine(line: string): boolean {
	const t = line.trim();
	if (!t || t.length > 110) return false;
	if (/^\[FIG p\d+-\d+\]/.test(t)) return false;
	if (LIST_ITEM_RE.test(t)) return false;
	if (/^#{1,6}\s+\S/.test(t)) return true;
	if (HEADING_NUMBERED_RE.test(t) && !/[.?!。？！]$/.test(t)) return true;
	if (/^[A-Z][A-Z0-9\s,&/-]{3,60}$/.test(t) && !/[.?!]$/.test(t)) return true;
	return false;
}

function cleanPageLines(
	page: ExtractedPage,
	pageCount: number,
	headerKeys: Set<string>,
	footerKeys: Set<string>,
): string[] {
	const rawLines = page.text.replace(/\r\n?/g, "\n").split("\n");
	const trimmed = rawLines.map((l) => l.replace(/[ \t]+/g, " ").trim());

	// Identify first and last non-empty non-figure line indices
	let firstIdx = -1;
	let lastIdx = -1;
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed[i] && !/^\[FIG p\d+-\d+\]$/.test(trimmed[i])) {
			if (firstIdx === -1) firstIdx = i;
			lastIdx = i;
		}
	}

	const result: string[] = [];
	for (let i = 0; i < trimmed.length; i++) {
		const line = trimmed[i];
		if (i === firstIdx && line) {
			if (
				headerKeys.has(normalizeEdgeKey(line)) ||
				isStandaloneEdgePageNumber(line, page.pageNumber, pageCount)
			) {
				continue;
			}
		}
		if (i === lastIdx && line && i !== firstIdx) {
			if (
				footerKeys.has(normalizeEdgeKey(line)) ||
				isStandaloneEdgePageNumber(line, page.pageNumber, pageCount)
			) {
				continue;
			}
		}
		result.push(line);
	}
	return result;
}

function buildBlocksFromPages(pages: ExtractedPage[]): TextBlock[] {
	const { headerKeys, footerKeys } = detectRepeatingHeadersAndFooters(pages);
	const rawBlocks: TextBlock[] = [];

	for (const page of pages) {
		const lines = cleanPageLines(page, pages.length, headerKeys, footerKeys);
		let currentKind: "paragraph" | "list" | undefined;
		let currentAcc = "";

		const flushCurrent = () => {
			const t = currentAcc.trim();
			if (t && currentKind) {
				rawBlocks.push({
					kind: currentKind,
					segments: [{ text: t, page: page.pageNumber }],
					text: t,
					pageStart: page.pageNumber,
					pageEnd: page.pageNumber,
				});
			}
			currentAcc = "";
			currentKind = undefined;
		};

		for (const line of lines) {
			if (!line) {
				flushCurrent();
				continue;
			}
			if (isHeadingLine(line)) {
				flushCurrent();
				rawBlocks.push({
					kind: "heading",
					segments: [{ text: line, page: page.pageNumber }],
					text: line,
					pageStart: page.pageNumber,
					pageEnd: page.pageNumber,
				});
				continue;
			}
			if (/^\[FIG p\d+-\d+\]/.test(line)) {
				flushCurrent();
				rawBlocks.push({
					kind: "paragraph",
					segments: [{ text: line, page: page.pageNumber }],
					text: line,
					pageStart: page.pageNumber,
					pageEnd: page.pageNumber,
				});
				continue;
			}
			if (LIST_ITEM_RE.test(line)) {
				if (currentKind === "list" && currentAcc) {
					currentAcc = `${currentAcc}\n${line}`;
				} else {
					flushCurrent();
					currentKind = "list";
					currentAcc = line;
				}
				continue;
			}
			// Continuation of a list item vs normal paragraph
			if (currentKind === "list") {
				const lastListLine = currentAcc.split("\n").at(-1) ?? "";
				const restLines = currentAcc.split("\n").slice(0, -1);
				const joinedLast = joinWrappedLines(lastListLine, line);
				currentAcc = [...restLines, joinedLast].join("\n");
				continue;
			}
			if (!currentKind) {
				currentKind = "paragraph";
				currentAcc = line;
			} else {
				currentAcc = joinWrappedLines(currentAcc, line);
			}
		}
		flushCurrent();
	}

	// Merge paragraphs that clearly continue across consecutive PDF pages while preserving per-page segments.
	const merged: TextBlock[] = [];
	for (const block of rawBlocks) {
		const prev = merged.at(-1);
		if (
			prev &&
			prev.kind === "paragraph" &&
			block.kind === "paragraph" &&
			block.pageStart === prev.pageEnd + 1 &&
			!TERMINAL_PUNCT_RE.test(prev.text) &&
			!/^\[FIG p\d+-\d+\]/.test(prev.text) &&
			!/^\[FIG p\d+-\d+\]/.test(block.text) &&
			/^[a-z\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(block.text)
		) {
			const prevLast = prev.segments.at(-1)!;
			const nextFirst = block.segments[0];
			const combinedPreview = joinWrappedLines(prevLast.text, nextFirst.text);
			// Determine how prevLast.text was joined with nextFirst.text
			let adjustedPrevText = prevLast.text;
			if (
				prevLast.text.endsWith("-") &&
				!combinedPreview.slice(0, prevLast.text.length).endsWith("-")
			) {
				adjustedPrevText = prevLast.text.slice(0, -1);
			} else if (combinedPreview.length === prevLast.text.length + 1 + nextFirst.text.length) {
				adjustedPrevText = `${prevLast.text} `;
			}
			prev.segments[prev.segments.length - 1] = {
				text: adjustedPrevText,
				page: prevLast.page,
			};
			prev.segments.push(...block.segments);
			prev.text = prev.segments.map((s) => s.text).join("");
			prev.pageEnd = block.pageEnd;
		} else {
			merged.push(block);
		}
	}

	return merged;
}

function buildCharSpansForSegments(segments: SourcedSegment[]): { fullText: string; spans: ChunkSpan[] } {
	let fullText = "";
	const spans: ChunkSpan[] = [];
	for (const seg of segments) {
		if (!seg.text) continue;
		const start = fullText.length;
		fullText += seg.text;
		const end = fullText.length;
		const prev = spans.at(-1);
		if (prev && prev.page === seg.page && prev.charEnd === start) {
			prev.charEnd = end;
		} else {
			spans.push({ page: seg.page, charStart: start, charEnd: end });
		}
	}
	return { fullText, spans };
}

function sliceSpans(spans: ChunkSpan[], sliceStart: number, sliceEnd: number): ChunkSpan[] {
	const out: ChunkSpan[] = [];
	for (const sp of spans) {
		const s = Math.max(sliceStart, sp.charStart);
		const e = Math.min(sliceEnd, sp.charEnd);
		if (s < e) {
			const relStart = s - sliceStart;
			const relEnd = e - sliceStart;
			const prev = out.at(-1);
			if (prev && prev.page === sp.page && prev.charEnd === relStart) {
				prev.charEnd = relEnd;
			} else {
				out.push({ page: sp.page, charStart: relStart, charEnd: relEnd });
			}
		}
	}
	return out;
}

/**
 * Split an oversized unit (`> maxTokens`) safely using the fallback hierarchy:
 * 1. Clause punctuation (`,`, `;`, `：`, `，`, `\n`)
 * 2. Natural word boundaries via `Intl.Segmenter("en", { granularity: "word" })`
 * 3. Grapheme cluster boundaries via `Intl.Segmenter("en", { granularity: "grapheme" })`
 */
function splitOversizedSlice(
	fullText: string,
	fullSpans: ChunkSpan[],
	start: number,
	end: number,
	maxTokens: number,
	isHeading: boolean,
	blockIndex: number,
): SentenceUnit[] {
	const raw = fullText.slice(start, end);
	const trimmedStartOffset = raw.length - raw.trimStart().length;
	const trimmedEndOffset = raw.trimEnd().length;
	const actualStart = start + trimmedStartOffset;
	const actualEnd = start + trimmedEndOffset;
	if (actualStart >= actualEnd) return [];

	const text = fullText.slice(actualStart, actualEnd);
	const tokens = estimateTokens(text);
	if (tokens <= maxTokens) {
		return [
			{
				text,
				tokens,
				isHeading,
				blockIndex,
				spans: sliceSpans(fullSpans, actualStart, actualEnd),
			},
		];
	}

	// Step 1: Try splitting at clause punctuation
	const clauseSplitPoints: number[] = [];
	const clauseRe = /[,;，；:：\n]+\s*/g;
	let m: RegExpExecArray | null;
	while ((m = clauseRe.exec(text)) !== null) {
		const idx = actualStart + m.index + m[0].length;
		if (idx > actualStart && idx < actualEnd) {
			clauseSplitPoints.push(idx);
		}
	}
	if (clauseSplitPoints.length > 0) {
		const midChar = actualStart + Math.floor((actualEnd - actualStart) / 2);
		let bestSplit = clauseSplitPoints[0];
		for (const pt of clauseSplitPoints) {
			if (Math.abs(pt - midChar) < Math.abs(bestSplit - midChar)) {
				bestSplit = pt;
			}
		}
		if (bestSplit > actualStart && bestSplit < actualEnd) {
			return [
				...splitOversizedSlice(fullText, fullSpans, actualStart, bestSplit, maxTokens, isHeading, blockIndex),
				...splitOversizedSlice(fullText, fullSpans, bestSplit, actualEnd, maxTokens, false, blockIndex),
			];
		}
	}

	// Step 2: Natural word boundaries via Intl.Segmenter("en", { granularity: "word" })
	const wordBoundaries: number[] = [];
	for (const seg of wordSegmenter.segment(text)) {
		if (seg.index > 0) wordBoundaries.push(actualStart + seg.index);
	}
	if (wordBoundaries.length > 0) {
		const midChar = actualStart + Math.floor((actualEnd - actualStart) / 2);
		let bestWordSplit = wordBoundaries[0];
		for (const pt of wordBoundaries) {
			if (Math.abs(pt - midChar) < Math.abs(bestWordSplit - midChar)) {
				bestWordSplit = pt;
			}
		}
		if (bestWordSplit > actualStart && bestWordSplit < actualEnd) {
			return [
				...splitOversizedSlice(fullText, fullSpans, actualStart, bestWordSplit, maxTokens, isHeading, blockIndex),
				...splitOversizedSlice(fullText, fullSpans, bestWordSplit, actualEnd, maxTokens, false, blockIndex),
			];
		}
	}

	// Step 3: Unicode grapheme cluster split (never splits surrogate pairs or grapheme clusters)
	const graphemes = Array.from(graphemeSegmenter.segment(text));
	if (graphemes.length <= 1) {
		return [
			{
				text,
				tokens,
				isHeading,
				blockIndex,
				spans: sliceSpans(fullSpans, actualStart, actualEnd),
			},
		];
	}
	const midGrapheme = graphemes[Math.floor(graphemes.length / 2)];
	const splitAt = actualStart + midGrapheme.index;
	return [
		...splitOversizedSlice(fullText, fullSpans, actualStart, splitAt, maxTokens, isHeading, blockIndex),
		...splitOversizedSlice(fullText, fullSpans, splitAt, actualEnd, maxTokens, false, blockIndex),
	];
}

function segmentBlockIntoSentences(block: TextBlock, blockIndex: number, maxTokens: number): SentenceUnit[] {
	const { fullText, spans } = buildCharSpansForSegments(block.segments);
	if (!fullText.trim()) return [];

	if (block.kind === "heading") {
		return splitOversizedSlice(fullText, spans, 0, fullText.length, maxTokens, true, blockIndex);
	}

	// Keep short lists together as a single unit when they fit within the soft window.
	if (block.kind === "list" && estimateTokens(fullText) <= Math.min(350, maxTokens)) {
		return splitOversizedSlice(fullText, spans, 0, fullText.length, maxTokens, false, blockIndex);
	}

	const rawRanges: Array<{ start: number; end: number }> = [];
	for (const seg of sentenceSegmenter.segment(fullText)) {
		const s = seg.index;
		const e = seg.index + seg.segment.length;
		const prev = rawRanges.at(-1);
		if (prev && ABBREV_END_RE.test(fullText.slice(prev.start, prev.end))) {
			prev.end = e;
		} else {
			rawRanges.push({ start: s, end: e });
		}
	}

	const units: SentenceUnit[] = [];
	for (const r of rawRanges) {
		units.push(...splitOversizedSlice(fullText, spans, r.start, r.end, maxTokens, false, blockIndex));
	}
	return units;
}

function assembleChunkFromUnits(units: SentenceUnit[], chunkIndex: number): DocumentChunk {
	let text = "";
	const spans: ChunkSpan[] = [];

	for (let i = 0; i < units.length; i++) {
		const u = units[i];
		if (i > 0) {
			const prevUnit = units[i - 1];
			const sep = prevUnit.isHeading || prevUnit.blockIndex !== u.blockIndex ? "\n\n" : " ";
			const sepStart = text.length;
			text += sep;
			const prevSpan = spans.at(-1);
			if (prevSpan) {
				prevSpan.charEnd = sepStart + sep.length;
			}
		}
		const baseOffset = text.length;
		text += u.text;
		for (const sp of u.spans) {
			const charStart = baseOffset + sp.charStart;
			const charEnd = baseOffset + sp.charEnd;
			const last = spans.at(-1);
			if (last && last.page === sp.page && last.charEnd >= charStart) {
				last.charEnd = Math.max(last.charEnd, charEnd);
			} else {
				spans.push({ page: sp.page, charStart, charEnd });
			}
		}
	}

	const pageSet = new Set<number>();
	for (const sp of spans) pageSet.add(sp.page);
	const pages = [...pageSet].sort((a, b) => a - b);
	const pageStart = pages[0] ?? 1;
	const pageEnd = pages.at(-1) ?? pageStart;

	return {
		chunkIndex,
		pageStart,
		pageEnd,
		pages,
		text,
		tokenEstimate: estimateTokens(text),
		spans,
	};
}

/**
 * Determine which 1-based PDF page(s) support a specific character span (or search match)
 * inside `chunk`. If `matchRange` is omitted, returns all pages in `chunk.pages`.
 */
export function pagesForChunkSpan(
	chunk: Pick<DocumentChunk, "pages" | "pageStart" | "spans">,
	matchRange?: { charStart: number; charEnd: number },
): number[] {
	if (!matchRange || chunk.spans.length === 0) {
		return chunk.pages.length > 0 ? chunk.pages : [chunk.pageStart];
	}
	const { charStart, charEnd } = matchRange;
	const matched = new Set<number>();
	for (const sp of chunk.spans) {
		if (Math.max(charStart, sp.charStart) < Math.min(charEnd, sp.charEnd)) {
			matched.add(sp.page);
		}
	}
	if (matched.size === 0) {
		return chunk.pages.length > 0 ? chunk.pages : [chunk.pageStart];
	}
	return [...matched].sort((a, b) => a - b);
}

/**
 * Deterministic structure- and sentence-aware chunker:
 * - Target ~600 tokens (soft window 500–800 tokens)
 * - Rewinds 1–3 complete trailing sentences for ~100 tokens overlap (80–120 tokens),
 *   never rewinding across a heading boundary and never stranding a heading at the end of a chunk.
 */
export function chunkDocumentPages(pagesData: PagesData, opts?: ChunkingOptions): DocumentChunk[] {
	const targetTokens = opts?.targetTokens ?? 600;
	const minWindowTokens = opts?.minWindowTokens ?? 500;
	const maxWindowTokens = opts?.maxWindowTokens ?? 800;
	const minOverlapTokens = opts?.minOverlapTokens ?? 80;
	const maxOverlapTokens = opts?.maxOverlapTokens ?? 120;

	const blocks = buildBlocksFromPages(pagesData.pages);
	if (blocks.length === 0) return [];

	const units: SentenceUnit[] = [];
	for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
		units.push(...segmentBlockIntoSentences(blocks[bIdx], bIdx, maxWindowTokens));
	}
	if (units.length === 0) return [];

	const chunks: DocumentChunk[] = [];
	let cursor = 0;

	while (cursor < units.length) {
		const startCursor = cursor;
		let currentTokens = 0;
		let endCursor = cursor;

		while (endCursor < units.length) {
			const u = units[endCursor];

			// If this is a heading and we already have enough content (>= minWindowTokens * 0.6),
			// break before the heading so the new section starts cleanly at the top of the next chunk.
			if (u.isHeading && endCursor > startCursor && currentTokens >= Math.floor(minWindowTokens * 0.6)) {
				break;
			}

			// Keep a heading attached to at least the first sentence following it.
			if (u.isHeading && endCursor + 1 < units.length) {
				const nextU = units[endCursor + 1];
				const combined = u.tokens + nextU.tokens;
				if (endCursor > startCursor && currentTokens + combined > maxWindowTokens) {
					break;
				}
				currentTokens += combined;
				endCursor += 2;
				continue;
			}

			if (endCursor > startCursor && currentTokens + u.tokens > maxWindowTokens) {
				break;
			}

			// Prefer stopping at a block boundary once we are inside the target window [targetTokens..maxWindowTokens].
			if (
				endCursor > startCursor &&
				currentTokens >= targetTokens &&
				u.blockIndex !== units[endCursor - 1].blockIndex
			) {
				break;
			}

			currentTokens += u.tokens;
			endCursor++;

			if (currentTokens >= targetTokens) {
				// If the next unit is in the same block and still fits comfortably within targetTokens + 60,
				// allow finishing the paragraph; otherwise stop here.
				const nextUnit = units[endCursor];
				if (!nextUnit || nextUnit.blockIndex !== u.blockIndex || currentTokens + nextUnit.tokens > targetTokens + 80) {
					break;
				}
			}
		}

		// Never strand a trailing heading at the end of a chunk if there are more units after it.
		while (endCursor - 1 > startCursor && endCursor < units.length && units[endCursor - 1].isHeading) {
			endCursor--;
		}

		// Guarantee forward progress.
		if (endCursor <= startCursor) {
			endCursor = startCursor + 1;
		}

		const chunkUnits = units.slice(startCursor, endCursor);
		chunks.push(assembleChunkFromUnits(chunkUnits, chunks.length));

		if (endCursor >= units.length) break;

		// Rewind 1–3 complete trailing sentences for ~80–120 tokens of overlap,
		// without crossing a heading boundary or exceeding maxOverlapTokens.
		let overlapUnits = 0;
		let overlapTokens = 0;
		for (let back = 1; back <= 3 && endCursor - back > startCursor; back++) {
			const candidate = units[endCursor - back];
			if (candidate.isHeading) break;
			if (back === 1 && candidate.tokens > maxOverlapTokens) {
				// Single trailing sentence alone exceeds the overlap budget: skip overlap.
				break;
			}
			if (overlapTokens + candidate.tokens > maxOverlapTokens && overlapUnits > 0) {
				break;
			}
			overlapTokens += candidate.tokens;
			overlapUnits = back;
			if (overlapTokens >= minOverlapTokens) {
				break;
			}
		}

		const nextCursor = endCursor - overlapUnits;
		cursor = nextCursor > startCursor ? nextCursor : endCursor;
	}

	return chunks;
}
