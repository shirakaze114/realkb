import { readFileSync } from "node:fs";
import type { ExtractedLine, ExtractedPage, PagesData } from "./storage.ts";

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CAPTION_LINE_RE = /^(?:figure|fig\.?|图|表)\s*(?:s\.?\s*)?\d+/i;

interface RawTextItem {
	str: string;
	x: number;
	y: number;
	width: number;
	height: number;
	hasEOL: boolean;
}

function shouldInsertSpaceBetween(left: string, right: string): boolean {
	if (!left || !right) return false;
	if (/\s$/.test(left) || /^\s/.test(right)) return false;
	const lastChar = Array.from(left).at(-1) ?? "";
	const firstChar = Array.from(right)[0] ?? "";
	if (CJK_CHAR_RE.test(lastChar) || CJK_CHAR_RE.test(firstChar)) return false;
	if (/^[.,;:!?%)\]}'"”’]/.test(firstChar)) return false;
	if (/^[([{"“‘/-]$/.test(lastChar)) return false;
	return true;
}

function groupItemsIntoLines(items: RawTextItem[]): ExtractedLine[] {
	const nonEmpty = items.filter((it) => it.str.length > 0);
	if (nonEmpty.length === 0) return [];

	// Sort top-to-bottom (descending y in PDF user space), then left-to-right (ascending x)
	const sorted = [...nonEmpty].sort((a, b) => {
		const dy = b.y - a.y;
		if (Math.abs(dy) > Math.max(2, Math.min(a.height, b.height) * 0.45)) {
			return dy;
		}
		return a.x - b.x;
	});

	const lines: Array<{ items: RawTextItem[]; y: number; height: number }> = [];
	for (const item of sorted) {
		const lastLine = lines.at(-1);
		const tolerance = lastLine ? Math.max(2.5, Math.min(lastLine.height, item.height) * 0.55) : 3;
		if (!lastLine || Math.abs(lastLine.y - item.y) > tolerance) {
			lines.push({ items: [item], y: item.y, height: Math.max(item.height, 8) });
		} else {
			lastLine.items.push(item);
			lastLine.y = (lastLine.y * (lastLine.items.length - 1) + item.y) / lastLine.items.length;
			lastLine.height = Math.max(lastLine.height, item.height);
		}
	}

	const extractedLines: ExtractedLine[] = [];
	for (const line of lines) {
		line.items.sort((a, b) => a.x - b.x);
		let text = "";
		let prevEnd = -Infinity;
		let minX = Infinity;
		let maxX = -Infinity;
		for (const it of line.items) {
			const cleanStr = it.str.replace(/\u0000/g, "");
			if (!cleanStr) continue;
			if (text.length > 0) {
				const gap = it.x - prevEnd;
				const charWidth = Math.max(3, it.height * 0.25);
				if (gap > charWidth && shouldInsertSpaceBetween(text, cleanStr)) {
					text += " ";
				}
			}
			text += cleanStr;
			minX = Math.min(minX, it.x);
			const endX = it.x + Math.max(it.width, cleanStr.length * it.height * 0.4);
			maxX = Math.max(maxX, endX);
			prevEnd = endX;
		}
		const trimmed = text.replace(/[ \t]+/g, " ").trim();
		if (trimmed) {
			extractedLines.push({
				text: trimmed,
				x: Number.isFinite(minX) ? Math.round(minX * 10) / 10 : 0,
				y: Math.round(line.y * 10) / 10,
				width: Number.isFinite(maxX - minX) ? Math.max(0, Math.round((maxX - minX) * 10) / 10) : 0,
				height: Math.round(line.height * 10) / 10,
			});
		}
	}

	return extractedLines;
}

function median(values: number[]): number {
	if (values.length === 0) return 12;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function assemblePageText(
	pageNumber: number,
	lines: ExtractedLine[],
	imageOpCount: number,
): { text: string; figureMarkers: string[]; hasUsableText: boolean } {
	const figureMarkers: string[] = [];
	let nextFigIndex = 1;
	const makeMarker = (): string => {
		const marker = `[FIG p${pageNumber}-${nextFigIndex++}]`;
		figureMarkers.push(marker);
		return marker;
	};

	const heights = lines.map((l) => l.height).filter((h) => h > 0);
	const medHeight = median(heights);
	const verticalGaps: number[] = [];
	for (let i = 1; i < lines.length; i++) {
		const gap = lines[i - 1].y - lines[i].y;
		if (gap > 0 && gap < medHeight * 6) verticalGaps.push(gap);
	}
	const medGap = verticalGaps.length > 0 ? median(verticalGaps) : medHeight * 1.25;
	const paraGapThreshold = Math.max(medHeight * 1.55, medGap * 1.45);

	const outputLines: string[] = [];
	let captionMarkersPlaced = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i > 0) {
			const prev = lines[i - 1];
			const verticalGap = prev.y - line.y;
			if (verticalGap > paraGapThreshold) {
				outputLines.push("");
			}
		}
		if (CAPTION_LINE_RE.test(line.text)) {
			const marker = makeMarker();
			captionMarkersPlaced++;
			outputLines.push(`${marker} ${line.text}`);
		} else {
			outputLines.push(line.text);
		}
	}

	// If the PDF page painted image objects that were not already represented by caption lines,
	// attach remaining page-scoped figure markers (capped at 8 per page to avoid noisy decorative icons).
	const remainingImageFigures = Math.max(0, Math.min(imageOpCount, 8) - captionMarkersPlaced);
	for (let k = 0; k < remainingImageFigures; k++) {
		const marker = makeMarker();
		if (outputLines.length > 0 && outputLines.at(-1) !== "") {
			outputLines.push("");
		}
		outputLines.push(marker);
	}

	const text = outputLines.join("\n").trim();

	// Check whether the page contains usable text beyond standalone numbers or figure markers.
	const stripped = lines
		.map((l) => l.text)
		.join(" ")
		.replace(/\[FIG p\d+-\d+\]/g, "")
		.replace(/^[-–—\s\d/.,()]+$/g, "")
		.trim();
	const hasUsableText = stripped.length >= 3;

	return { text, figureMarkers, hasUsableText };
}

/**
 * Extract per-page text, line layout metadata, and `[FIG pX-Y]` figure markers from a PDF file
 * using bundled `pdfjs-dist`. Does not perform OCR or export external image files.
 */
export async function extractPdfPages(pdfPath: string, fullHash: string): Promise<PagesData> {
	const rawBytes = readFileSync(pdfPath);
	const data = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);

	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const loadingTask = pdfjs.getDocument({
		data,
		useSystemFonts: true,
		disableFontFace: true,
		verbosity: 0,
	});

	const doc = await loadingTask.promise;
	try {
		const pageCount = doc.numPages;
		const pages: ExtractedPage[] = [];
		const imageOps = new Set<number>(
			[
				pdfjs.OPS?.paintImageXObject,
				pdfjs.OPS?.paintInlineImageXObject,
				pdfjs.OPS?.paintImageXObjectRepeat,
			].filter((x): x is number => typeof x === "number"),
		);

		for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
			const page = await doc.getPage(pageNum);
			try {
				const textContent = await page.getTextContent();
				const rawItems: RawTextItem[] = [];
				for (const item of textContent.items as Array<Record<string, unknown>>) {
					if (typeof item.str !== "string") continue;
					const tr = Array.isArray(item.transform) ? (item.transform as number[]) : [1, 0, 0, 1, 0, 0];
					const x = typeof tr[4] === "number" && Number.isFinite(tr[4]) ? tr[4] : 0;
					const y = typeof tr[5] === "number" && Number.isFinite(tr[5]) ? tr[5] : 0;
					const width = typeof item.width === "number" && Number.isFinite(item.width) ? item.width : 0;
					const height =
						typeof item.height === "number" && Number.isFinite(item.height) && item.height > 0
							? item.height
							: Math.abs(typeof tr[3] === "number" ? tr[3] : 10);
					rawItems.push({
						str: item.str,
						x,
						y,
						width,
						height,
						hasEOL: Boolean(item.hasEOL),
					});
				}

				let imageOpCount = 0;
				try {
					const opList = await page.getOperatorList();
					if (Array.isArray(opList?.fnArray)) {
						for (const fnId of opList.fnArray) {
							if (imageOps.has(fnId)) imageOpCount++;
						}
					}
				} catch {
					// If operator list inspection fails on a malformed page, still keep text extraction.
				}

				const lines = groupItemsIntoLines(rawItems);
				const assembled = assemblePageText(pageNum, lines, imageOpCount);
				pages.push({
					pageNumber: pageNum,
					text: assembled.text,
					hasUsableText: assembled.hasUsableText,
					figureMarkers: assembled.figureMarkers,
					lines,
				});
			} finally {
				page.cleanup?.();
			}
		}

		return {
			fullHash,
			pageCount,
			extractedAt: new Date().toISOString(),
			pages,
		};
	} finally {
		await doc.destroy();
	}
}

/**
 * Extract UTF-8 text from a plain-text (`.txt`) or Markdown (`.md`) file as a single-page `PagesData` record.
 */
export function extractTextPages(filePath: string, fullHash: string): PagesData {
	const raw = readFileSync(filePath, "utf8")
		.replace(/^\uFEFF/, "")
		.replace(/\u0000/g, "")
		.replace(/\r\n?/g, "\n")
		.trim();
	const hasUsableText = raw.length > 0;
	return {
		fullHash,
		pageCount: 1,
		extractedAt: new Date().toISOString(),
		pages: [
			{
				pageNumber: 1,
				text: raw,
				hasUsableText,
				figureMarkers: [],
			},
		],
	};
}
