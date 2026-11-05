import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chunkDocumentPages, estimateTokens, pagesForChunkSpan } from "../src/chunker.ts";
import { extractPdfPages } from "../src/pdf.ts";
import type { PagesData } from "../src/storage.ts";
import { buildTestPdf } from "./helpers/pdf-builder.ts";

describe("PDF extraction and structure-aware sentence chunker", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "realkb-test-chunker-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("extracts multi-page PDF text, inserts [FIG pX-Y] markers, and flags empty/scanned pages", async () => {
		const pdfBytes = buildTestPdf([
			[
				"1 Introduction to Distributed Consensus",
				"",
				"Consensus protocols allow a cluster of nodes to agree on a state machine log.",
				"Figure 1: Raft leader election state transition diagram.",
			],
			[
				// Simulated scanned page with no selectable text
			],
			[
				"2 Log Replication Details",
				"",
				"Once a leader is elected, it begins servicing client requests.",
				"Figure 2: Log replication across follower nodes.",
			],
		]);

		const pdfPath = join(tempDir, "consensus.pdf");
		writeFileSync(pdfPath, pdfBytes);

		const pagesData = await extractPdfPages(pdfPath, "a".repeat(64));
		assert.equal(pagesData.pageCount, 3);
		assert.equal(pagesData.pages[0].hasUsableText, true);
		assert.match(pagesData.pages[0].text, /\[FIG p1-1\] Figure 1:/);

		assert.equal(pagesData.pages[1].hasUsableText, false);

		assert.equal(pagesData.pages[2].hasUsableText, true);
		assert.match(pagesData.pages[2].text, /\[FIG p3-1\] Figure 2:/);
	});

	it("strips repeating headers/footers, repairs line-break hyphenation, and preserves compound hyphens", () => {
		const pagesData: PagesData = {
			fullHash: "b".repeat(64),
			pageCount: 3,
			extractedAt: new Date().toISOString(),
			pages: [
				{
					pageNumber: 1,
					hasUsableText: true,
					figureMarkers: [],
					text: [
						"Journal of Systems Architecture 2026",
						"1 System Overview",
						"This architecture provides a self-",
						"contained runtime with automatic pattern recog-",
						"nition across distributed nodes.",
						"Page 1 of 3",
					].join("\n"),
				},
				{
					pageNumber: 2,
					hasUsableText: true,
					figureMarkers: [],
					text: [
						"Journal of Systems Architecture 2026",
						"The runtime verifies non-",
						"empty state transitions during leader election.",
						"Page 2 of 3",
					].join("\n"),
				},
				{
					pageNumber: 3,
					hasUsableText: true,
					figureMarkers: [],
					text: [
						"Journal of Systems Architecture 2026",
						"Final verification completes in bounded time.",
						"Page 3 of 3",
					].join("\n"),
				},
			],
		};

		const chunks = chunkDocumentPages(pagesData);
		assert.equal(chunks.length >= 1, true);
		const combinedText = chunks.map((c) => c.text).join("\n");

		// Repeating header and standalone page numbers removed from derived chunks
		assert.equal(combinedText.includes("Journal of Systems Architecture 2026"), false);
		assert.equal(combinedText.includes("Page 1 of 3"), false);

		// Hyphenated split word repaired ("recognition"), compound words keep hyphen ("self-contained", "non-empty")
		assert.match(combinedText, /\brecognition\b/);
		assert.match(combinedText, /\bself-contained\b/);
		assert.match(combinedText, /\bnon-empty\b/);
	});

	it("packs chunks with whole-sentence overlap, never strands headings, and tracks multi-page spans", () => {
		const makeSentences = (prefix: string, count: number) =>
			Array.from(
				{ length: count },
				(_, i) =>
					`${prefix} sentence number ${i + 1} explains how the deterministic replication protocol handles quorum reads and writes reliably.`,
			).join(" ");

		const pagesData: PagesData = {
			fullHash: "c".repeat(64),
			pageCount: 3,
			extractedAt: new Date().toISOString(),
			pages: [
				{
					pageNumber: 1,
					hasUsableText: true,
					figureMarkers: [],
					text: `1 Quorum Replication\n\n${makeSentences("PageOne", 18)}`,
				},
				{
					pageNumber: 2,
					hasUsableText: true,
					figureMarkers: [],
					text: `${makeSentences("PageTwo", 18)}\n\n2 Recovery Protocol\n\n${makeSentences("PageTwoSectionTwo", 10)}`,
				},
				{
					pageNumber: 3,
					hasUsableText: true,
					figureMarkers: [],
					text: `分布式系统的共识算法需要保证安全性与活性。当主节点发生故障时，备份节点通过选举产生新的主节点，并继续处理客户端请求。\n\n${makeSentences("PageThree", 12)}`,
				},
			],
		};

		const chunks = chunkDocumentPages(pagesData, {
			targetTokens: 240,
			minWindowTokens: 180,
			maxWindowTokens: 320,
			minOverlapTokens: 30,
			maxOverlapTokens: 60,
		});

		assert.equal(chunks.length >= 3, true);
		for (let i = 0; i < chunks.length; i++) {
			assert.equal(chunks[i].chunkIndex, i);
			// No chunk should end with a stranded heading line
			const lines = chunks[i].text.trim().split("\n");
			assert.notEqual(lines.at(-1)?.trim(), "2 Recovery Protocol");
		}

		// Verify multi-page span lookup accurately pinpoints the exact page
		const multiPageChunk = chunks.find((c) => c.pages.length > 1);
		assert.ok(multiPageChunk, "Expected at least one chunk spanning across a page boundary");
		const idxPageTwo = multiPageChunk.text.indexOf("PageTwo");
		if (idxPageTwo >= 0) {
			const pages = pagesForChunkSpan(multiPageChunk, {
				charStart: idxPageTwo,
				charEnd: idxPageTwo + 7,
			});
			assert.deepEqual(pages, [2]);
		}

		// Verify CJK content is preserved and estimated
		const cjkChunk = chunks.find((c) => c.text.includes("分布式系统的共识算法"));
		assert.ok(cjkChunk);
		assert.ok(estimateTokens("分布式系统的共识算法") >= 10);
	});

	it("handles oversized unpunctuated strings and emoji grapheme clusters without stalling", () => {
		const giantToken = `https://example.com/${"a👍🏽b".repeat(400)}`;
		const pagesData: PagesData = {
			fullHash: "d".repeat(64),
			pageCount: 1,
			extractedAt: new Date().toISOString(),
			pages: [
				{
					pageNumber: 1,
					hasUsableText: true,
					figureMarkers: [],
					text: giantToken,
				},
			],
		};

		const chunks = chunkDocumentPages(pagesData, {
			targetTokens: 120,
			minWindowTokens: 80,
			maxWindowTokens: 160,
		});
		assert.ok(chunks.length >= 2);
		// Ensure no lone surrogates were created when splitting
		for (const c of chunks) {
			assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c.text), false);
		}
	});
});
