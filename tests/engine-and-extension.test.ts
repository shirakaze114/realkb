import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import realkbExtension from "../extensions/realkb/index.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { getSourceInfo, importPdfsToKb, readFromKb, searchConnectedKbs } from "../src/engine.ts";
import { createKb, loadSourceMeta, loadSourcePages } from "../src/storage.ts";
import { buildTestPdf } from "./helpers/pdf-builder.ts";

function deterministicVector(text: string, dim: number): Float32Array {
	const out = new Float32Array(dim);
	const lower = text.toLowerCase();
	// Assign strong semantic axes for test concepts so vector search ranks related passages first
	if (lower.includes("raft") || lower.includes("consensus") || lower.includes("quorum") || lower.includes("leader")) {
		out[0] += 5;
	}
	if (lower.includes("compiler") || lower.includes("register") || lower.includes("ssa") || lower.includes("optimiz")) {
		out[1] += 5;
	}
	if (lower.includes("quantum") || lower.includes("qubit") || lower.includes("entangle")) {
		out[2] += 5;
	}
	const digest = createHash("sha256").update(lower, "utf8").digest();
	for (let i = 0; i < dim; i++) {
		out[i] += ((digest[i % digest.length] ?? 0) / 255 - 0.5) * 0.2;
	}
	let normSq = 0;
	for (let i = 0; i < dim; i++) normSq += out[i] * out[i];
	const norm = Math.sqrt(normSq) || 1;
	for (let i = 0; i < dim; i++) out[i] /= norm;
	return out;
}

function float32ToBase64(vec: Float32Array): string {
	const buf = Buffer.alloc(vec.length * 4);
	for (let i = 0; i < vec.length; i++) {
		buf.writeFloatLE(vec[i], i * 4);
	}
	return buf.toString("base64");
}

describe("import pipeline, hybrid search, read, source_info, and Pi extension", () => {
	let tempRoot: string;
	let pdfDir: string;
	let server: Server;
	let baseUrl: string;
	let serverFailMode: "none" | "http500" | "inputTooLongAbove250Chars" = "none";
	let embedCallCount = 0;
	const DIMS = 64;

	beforeEach(async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "realkb-test-engine-"));
		pdfDir = mkdtempSync(join(tmpdir(), "realkb-test-pdfs-"));
		process.env.REALKB_DIR = tempRoot;
		serverFailMode = "none";
		embedCallCount = 0;

		server = createServer(async (req, res) => {
			if (req.method !== "POST" || req.url !== "/v1/embeddings") {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
			const chunks: Buffer[] = [];
			for await (const ch of req) chunks.push(ch as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				input: string[];
				dimensions?: number;
				encoding_format?: string;
			};

			embedCallCount++;

			if (serverFailMode === "http500") {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "Simulated upstream failure" } }));
				return;
			}

			if (
				serverFailMode === "inputTooLongAbove250Chars" &&
				body.input.some((t) => t.length > 250)
			) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						error: { message: "maximum context length exceeded: input is too long" },
					}),
				);
				return;
			}

			const dim = body.dimensions ?? DIMS;
			const data = body.input.map((text, index) => {
				const vec = deterministicVector(text, dim);
				return {
					index,
					embedding: body.encoding_format === "base64" ? float32ToBase64(vec) : Array.from(vec),
				};
			});

			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data, usage: { prompt_tokens: 10, total_tokens: 10 } }));
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const port = (server.address() as AddressInfo).port;
		baseUrl = `http://127.0.0.1:${port}/v1`;

		const cfg = loadConfig(tempRoot);
		cfg.embedding.endpoint = baseUrl;
		cfg.embedding.model = "test-embedding-model";
		cfg.embedding.dimensions = DIMS;
		cfg.embedding.apiKey = "test-key";
		saveConfig(cfg, tempRoot);
	});

	afterEach(async () => {
		delete process.env.REALKB_DIR;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(tempRoot, { recursive: true, force: true });
		rmSync(pdfDir, { recursive: true, force: true });
	});

	it("imports PDFs, deduplicates identical imports, retries failed imports reusing extraction, and runs hybrid search + read", async () => {
		const kb = await createKb("Systems Library", tempRoot);

		const raftPdfPath = join(pdfDir, "raft-paper.pdf");
		writeFileSync(
			raftPdfPath,
			buildTestPdf([
				[
					"1 Raft Consensus Overview",
					"Raft is a consensus algorithm for managing a replicated log across cluster servers.",
					"Leader election ensures a single leader coordinates log replication.",
				],
				[
					"2 Safety and Quorum Rules",
					"A leader commits a log entry only after a majority quorum of followers has replicated it.",
					"Figure 1: Quorum intersection guarantees safety across terms.",
				],
			]),
		);

		const scannedEmptyPdfPath = join(pdfDir, "scanned-empty.pdf");
		writeFileSync(scannedEmptyPdfPath, buildTestPdf([[], []]));

		// 1. Test failure during embedding preserves extracted pages.json and marks status='failed'
		serverFailMode = "http500";
		const failedBatch = await importPdfsToKb({
			kbIdOrName: kb.id,
			paths: [raftPdfPath],
			cwd: pdfDir,
			rootDir: tempRoot,
		});
		assert.equal(failedBatch.ready.length, 0);
		assert.equal(failedBatch.failed.length, 1);
		assert.equal(failedBatch.failed[0].failingStep, "embed");
		const failedHash = failedBatch.failed[0].fullHash!;
		assert.equal(loadSourceMeta(tempRoot, kb.id, failedHash)?.status, "failed");
		assert.ok(loadSourcePages(tempRoot, kb.id, failedHash), "Expected pages.json to be preserved on embed failure");

		// 2. Restore embedding server (with input-length split fallback active) and retry batch with both raft + scanned-empty
		serverFailMode = "inputTooLongAbove250Chars";
		const retryBatch = await importPdfsToKb({
			kbIdOrName: kb.id,
			paths: [raftPdfPath, scannedEmptyPdfPath],
			cwd: pdfDir,
			rootDir: tempRoot,
		});
		assert.equal(retryBatch.ready.length, 1);
		assert.equal(retryBatch.ready[0].reusedExtraction, true);
		assert.equal(retryBatch.ready[0].figureCount, 1);
		assert.equal(retryBatch.failed.length, 1);
		assert.equal(retryBatch.failed[0].filename, "scanned-empty.pdf");
		assert.equal(retryBatch.failed[0].failingStep, "extract");

		// 3. Re-importing already ready PDF skips duplicate
		serverFailMode = "none";
		const callsBeforeDup = embedCallCount;
		const dupBatch = await importPdfsToKb({
			kbIdOrName: kb.id,
			paths: [raftPdfPath],
			cwd: pdfDir,
			rootDir: tempRoot,
		});
		assert.equal(dupBatch.alreadyImported.length, 1);
		assert.equal(dupBatch.ready.length, 0);
		assert.equal(embedCallCount, callsBeforeDup);

		// 4. Searching without connected KBs throws access boundary error
		await assert.rejects(
			() =>
				searchConnectedKbs({
					query: "majority quorum replication",
					connectedKbIds: [],
					rootDir: tempRoot,
				}),
			/No knowledge bases are connected/,
		);

		// 5. Hybrid vector + FTS5 search on connected KB returns passage and exact page citation
		const searchRes = await searchConnectedKbs({
			query: "majority quorum log entry",
			connectedKbIds: [kb.id],
			rootDir: tempRoot,
		});
		assert.equal(searchRes.degradedToKeywordOnly, false);
		assert.ok(searchRes.hits.length >= 1);
		const topHit = searchRes.hits[0];
		assert.equal(topHit.kbId, "001");
		assert.match(topHit.text, /majority quorum/);
		assert.ok(topHit.citations.some((c) => c.endsWith("p2]")));

		// 6. Degrade gracefully to keyword-only search when embedding API fails or fingerprint changes
		serverFailMode = "http500";
		const degradedSearch = await searchConnectedKbs({
			query: "majority quorum",
			connectedKbIds: [kb.id],
			rootDir: tempRoot,
		});
		assert.equal(degradedSearch.degradedToKeywordOnly, true);
		assert.ok(degradedSearch.warnings.length > 0);
		assert.ok(degradedSearch.hits.length >= 1);

		// 7. Read chunks and pages via realkb_read engine function
		const chunkRead = readFromKb({
			ref: topHit.documentCitation,
			connectedKbIds: [kb.id],
			chunk: 0,
			neighbors: 1,
			rootDir: tempRoot,
		});
		assert.equal(chunkRead.mode, "chunks");
		assert.ok(chunkRead.passages.length >= 1);

		const pageRead = readFromKb({
			ref: `${kb.id}_${topHit.shortHash}p2`,
			connectedKbIds: [kb.id],
			rootDir: tempRoot,
		});
		assert.equal(pageRead.mode, "pages");
		assert.equal(pageRead.passages[0].pageStart, 2);
		assert.match(pageRead.passages[0].text, /\[FIG p2-1\] Figure 1:/);

		// 8. Resolve source info even when KB is disconnected
		const info = getSourceInfo(`001:${topHit.shortHash}p2`, tempRoot);
		assert.equal(info.kb.id, "001");
		assert.equal(info.requestedPage, 2);
		assert.equal(info.source.originalFilename, "raft-paper.pdf");
	});

	it("registers extension tools/commands and enforces approval modes and session overrides", async () => {
		const tools = new Map<string, ToolDefinition<any>>();
		const commands = new Map<string, any>();
		const handlers = new Map<string, Array<(...args: any[]) => any>>();
		const branchEntries: Array<{ type: string; customType?: string; data?: unknown }> = [];
		const sentMessages: Array<{ msg: any; opts: any }> = [];
		let markdownTransformer: ((md: string) => string) | undefined;

		const mockPi = {
			on(event: string, handler: (...args: any[]) => any) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return () => {};
			},
			registerTool(def: ToolDefinition<any>) {
				tools.set(def.name, def);
			},
			registerCommand(name: string, def: any) {
				commands.set(name, def);
			},
			registerMarkdownTransformer(fn: (md: string) => string) {
				markdownTransformer = fn;
			},
			registerMessageRenderer() {},
			sendMessage(msg: any, opts: any) {
				sentMessages.push({ msg, opts });
			},
			appendEntry(customType: string, data?: unknown) {
				branchEntries.push({ type: "custom", customType, data });
			},
		} as unknown as ExtensionAPI;

		realkbExtension(mockPi);

		assert.ok(tools.has("realkb_list"));
		assert.ok(tools.has("realkb_create"));
		assert.ok(tools.has("realkb_connect"));
		assert.ok(tools.has("realkb_import"));
		assert.ok(tools.has("realkb_search"));
		assert.ok(tools.has("realkb_read"));
		assert.ok(tools.has("realkb_source_info"));
		assert.ok(commands.has("realkb"));
		assert.ok(markdownTransformer);

		let nextSelectIndex = 0;
		const statusUpdates = new Map<string, string | undefined>();
		const notifications: string[] = [];
		const mockCtx: any = {
			cwd: pdfDir,
			hasUI: true,
			mode: "tui",
			sessionManager: {
				getSessionId: () => "session-ext-1",
				getBranch: () => branchEntries,
			},
			ui: {
				select: async (_title: string, options: string[]) => options[nextSelectIndex],
				input: async () => "Not needed right now",
				notify: (msg: string) => {
					notifications.push(msg);
				},
				setWidget: () => {},
				setStatus: (key: string, val: string | undefined) => {
					statusUpdates.set(key, val);
				},
			},
		};

		// Trigger session_start
		for (const h of handlers.get("session_start") ?? []) {
			await h({ type: "session_start", reason: "startup" }, mockCtx);
		}

		// 1. User declines realkb_create when choice index = 1 ("No")
		nextSelectIndex = 1;
		const declinedCreate = await tools
			.get("realkb_create")!
			.execute("call-1", { name: "Declined KB" }, undefined, undefined, mockCtx);
		assert.equal((declinedCreate.details as any).declined, true);
		assert.equal((declinedCreate.details as any).reason, "Not needed right now");

		// 2. User selects "Yes, and don't ask again for connections this session" (index 2)
		nextSelectIndex = 2;
		const createdRes = await tools
			.get("realkb_create")!
			.execute("call-2", { name: "Compiler Papers" }, undefined, undefined, mockCtx);
		assert.equal((createdRes.details as any).kb.id, "001");
		assert.equal(statusUpdates.get("realkb"), "·📚 1");

		// 3. Subsequent connect/create in same session does not prompt even if nextSelectIndex = 1 ("No")
		nextSelectIndex = 1;
		const secondCreate = await tools
			.get("realkb_create")!
			.execute("call-3", { name: "Second KB" }, undefined, undefined, mockCtx);
		assert.equal((secondCreate.details as any).kb.id, "002");
		assert.equal(statusUpdates.get("realkb"), "·📚 2");

		// Disconnect 002 and verify /realkb status only shows connected KBs (001)
		await commands.get("realkb")!.handler("disconnect 002", mockCtx);
		assert.equal(statusUpdates.get("realkb"), "·📚 1");
		notifications.length = 0;
		await commands.get("realkb")!.handler("status", mockCtx);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /realkb connected knowledge bases \(1\):/);
		assert.match(notifications[0], /001 "Compiler Papers" \[connected\]/);
		assert.doesNotMatch(notifications[0], /002 "Second KB"/);

		// 4. Import still prompts because import approval override is separate from connect override
		const samplePdf = join(pdfDir, "compiler.pdf");
		writeFileSync(
			samplePdf,
			buildTestPdf([
				[
					"1 Static Single Assignment",
					"SSA form simplifies register allocation and constant propagation in optimizing compilers.",
				],
			]),
		);

		nextSelectIndex = 0; // "Yes, import ..."
		const progressUpdates: any[] = [];
		const importRes = await tools
			.get("realkb_import")!
			.execute(
				"call-4",
				{ kb: "001", paths: [samplePdf] },
				undefined,
				(u) => progressUpdates.push(u),
				mockCtx,
			);
		assert.equal((importRes.details as any).ready.length, 1);
		assert.ok(progressUpdates.length >= 1, "Expected foreground 1-PDF import to stream progress updates");

		// 5. Importing >= 2 PDFs defaults to run_in_background = true and sends <realkb-notification> when finished
		const samplePdf2 = join(pdfDir, "quantum.pdf");
		writeFileSync(
			samplePdf2,
			buildTestPdf([
				[
					"1 Quantum Error Correction",
					"Surface codes protect logical qubits against decoherence using stabilizer measurements.",
				],
			]),
		);

		nextSelectIndex = 2; // "Yes, and don't ask again for imports this session"
		const bgRes = await tools
			.get("realkb_import")!
			.execute("call-5", { kb: "001", paths: [samplePdf, samplePdf2] }, undefined, undefined, mockCtx);
		assert.equal((bgRes.details as any).background, true);
		assert.equal((bgRes.details as any).status, "running");
		assert.equal((bgRes.details as any).totalFiles, 2);

		// Wait for background job completion notification
		for (let i = 0; i < 40 && sentMessages.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.equal(sentMessages.length, 1);
		assert.equal(sentMessages[0].msg.customType, "realkb-notification");
		assert.match(sentMessages[0].msg.content, /<realkb-notification id="imp-2" kb="001" status="completed"/);

		// 6. Single specific .md and .txt files can be imported without allow_ext and searched
		const notesMd = join(pdfDir, "compiler-notes.md");
		writeFileSync(
			notesMd,
			"# Register Allocation\n\nGraph coloring register allocation assigns SSA virtual registers to physical machine registers.",
		);
		const singleMdRes = await tools
			.get("realkb_import")!
			.execute("call-6", { kb: "001", paths: [notesMd] }, undefined, undefined, mockCtx);
		assert.equal((singleMdRes.details as any).ready.length, 1);
		assert.equal((singleMdRes.details as any).ready[0].filename, "compiler-notes.md");

		const mdSearch = await tools
			.get("realkb_search")!
			.execute("call-7", { query: "Graph coloring register allocation", kbs: ["001"] }, undefined, undefined, mockCtx);
		assert.ok((mdSearch.details as any).hits.some((h: any) => h.filename === "compiler-notes.md"));
	});
});
