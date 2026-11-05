import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	configFilePath,
	embeddingFingerprint,
	loadConfig,
	maskSecret,
	normalizeEndpoint,
	resolveSecret,
	saveConfig,
} from "../src/config.ts";
import { linkifyCitationsInMarkdown } from "../src/engine.ts";
import { SessionStateManager } from "../src/session-state.ts";
import {
	assignShortHash,
	cleanupUnreferencedObjects,
	createKb,
	ensureSharedOriginalPdf,
	formatCitation,
	hashFileSha256,
	inspectImportPaths,
	listKbs,
	parseReference,
	resolveKb,
	saveSourceMeta,
	type SourceMeta,
} from "../src/storage.ts";

describe("config, storage, identities, citations, and session state", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "realkb-test-storage-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("saves config.json with 0600 permissions and resolves env secrets without leaking", () => {
		const cfg = loadConfig(tempRoot);
		assert.equal(cfg.approvalMode, "ask");

		cfg.approvalMode = "yolo";
		cfg.embedding.endpoint = "https://api.example.com/v1/";
		cfg.embedding.model = "Qwen/Qwen3-Embedding-8B";
		cfg.embedding.apiKey = "$REALKB_TEST_SECRET_KEY";
		cfg.embedding.dimensions = 1024;
		saveConfig(cfg, tempRoot);

		const file = configFilePath(tempRoot);
		const mode = statSync(file).mode & 0o777;
		assert.equal(mode, 0o600);

		const reloaded = loadConfig(tempRoot);
		assert.equal(reloaded.approvalMode, "yolo");
		assert.equal(normalizeEndpoint(reloaded.embedding.endpoint), "https://api.example.com");
		assert.equal(
			embeddingFingerprint(reloaded),
			"https://api.example.com|qwen/qwen3-embedding-8b|1024",
		);

		process.env.REALKB_TEST_SECRET_KEY = "sk-super-secret-value";
		try {
			assert.equal(resolveSecret(reloaded.embedding.apiKey), "sk-super-secret-value");
			assert.equal(resolveSecret("env:REALKB_TEST_SECRET_KEY"), "sk-super-secret-value");
			assert.equal(maskSecret(reloaded.embedding.apiKey), "$REALKB_TEST_SECRET_KEY");
			assert.equal(maskSecret("sk-raw-secret"), "(configured)");
			assert.equal(maskSecret(""), "(not set)");
		} finally {
			delete process.env.REALKB_TEST_SECRET_KEY;
		}
	});

	it("allocates permanent numeric KB IDs and never reuses deleted KB numbers", async () => {
		const kb1 = await createKb("Compilers", tempRoot);
		const kb2 = await createKb("Distributed Systems", tempRoot);
		assert.equal(kb1.id, "001");
		assert.equal(kb2.id, "002");

		// Simulate deleting KB 002 directory on disk
		rmSync(join(tempRoot, "kbs", "002"), { recursive: true, force: true });
		assert.deepEqual(
			listKbs(tempRoot).map((k) => k.id),
			["001"],
		);

		// Creating another KB must allocate 003, never reusing 002
		const kb3 = await createKb("Operating Systems", tempRoot);
		assert.equal(kb3.id, "003");
		assert.equal(resolveKb(tempRoot, "3")?.name, "Operating Systems");
		assert.equal(resolveKb(tempRoot, "operating systems")?.id, "003");
	});

	it("assigns 7-char short hashes and extends to 8+ chars on prefix collision without changing existing IDs", async () => {
		const kb = await createKb("Collision Test", tempRoot);
		const hashA = "c676ea9111111111111111111111111111111111111111111111111111111111";
		const hashB = "c676ea9222222222222222222222222222222222222222222222222222222222";
		const hashC = "c676ea9233333333333333333333333333333333333333333333333333333333";

		const shortA = assignShortHash(tempRoot, kb.id, hashA);
		assert.equal(shortA, "c676ea9");

		const metaA: SourceMeta = {
			fullHash: hashA,
			shortHash: shortA,
			originalFilename: "a.pdf",
			originalPath: "/tmp/a.pdf",
			objectRelPath: `objects/${hashA}.pdf`,
			fileSize: 100,
			importedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			status: "ready",
			pageCount: 1,
			usableTextPages: 1,
			unreadablePages: [],
			figureCount: 0,
		};
		saveSourceMeta(tempRoot, kb.id, metaA);

		// Re-assigning for the same fullHash keeps its existing shortHash
		assert.equal(assignShortHash(tempRoot, kb.id, hashA), "c676ea9");

		// Different fullHash sharing 7-char prefix gets 8-char prefix
		const shortB = assignShortHash(tempRoot, kb.id, hashB);
		assert.equal(shortB, "c676ea92");
		saveSourceMeta(tempRoot, kb.id, {
			...metaA,
			fullHash: hashB,
			shortHash: shortB,
			originalFilename: "b.pdf",
		});

		// Third hash sharing 8-char prefix with B gets 9-char prefix
		const shortC = assignShortHash(tempRoot, kb.id, hashC);
		assert.equal(shortC, "c676ea923");
	});

	it("parses citations/references and linkifies citations in Markdown outside code blocks", async () => {
		const kb = await createKb("Citation KB", tempRoot);
		const fullHash = "c676ea9abcdef0123456789abcdef0123456789abcdef0123456789abcdef012";
		saveSourceMeta(tempRoot, kb.id, {
			fullHash,
			shortHash: "c676ea9",
			originalFilename: "paper.pdf",
			originalPath: "/tmp/paper.pdf",
			objectRelPath: `objects/${fullHash}.pdf`,
			fileSize: 123,
			importedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			status: "ready",
			pageCount: 10,
			usableTextPages: 10,
			unreadablePages: [],
			figureCount: 0,
		});

		assert.equal(formatCitation("001", "c676ea9"), "[rkb:001_c676ea9]");
		assert.equal(formatCitation("001", "c676ea9", 7), "[rkb:001_c676ea9p7]");

		assert.deepEqual(parseReference("[rkb:001_c676ea9p7]"), {
			kbId: "001",
			sourceHash: "c676ea9",
			page: 7,
		});
		assert.deepEqual(parseReference("1:c676ea9p12"), {
			kbId: "001",
			sourceHash: "c676ea9",
			page: 12,
		});
		assert.deepEqual(parseReference("[1:c676ea9,p12]"), {
			kbId: "001",
			sourceHash: "c676ea9",
			page: 12,
		});
		assert.deepEqual(parseReference("001_c676ea9"), {
			kbId: "001",
			sourceHash: "c676ea9",
			page: undefined,
		});
		assert.equal(parseReference("invalid_ref"), undefined);

		const md = [
			"Evidence on page 7 [rkb:001_c676ea9p7] and doc [rkb:001_c676ea9].",
			"Inline code `[rkb:001_c676ea9p7]` must not be altered.",
			"```ts",
			"const ref = '[rkb:001_c676ea9p7]';",
			"```",
		].join("\n");

		const transformed = linkifyCitationsInMarkdown(md, tempRoot);
		assert.match(transformed, /\[\[1:c676ea9,p7\]\]\(file:\/\/.*#page=7\)/);
		assert.match(transformed, /\[\[1:c676ea9\]\]\(file:\/\/.*\.pdf\)/);
		assert.match(transformed, /`\[rkb:001_c676ea9p7\]`/);
		assert.match(transformed, /const ref = '\[rkb:001_c676ea9p7\]';/);
	});

	it("inspects import directories recursively, skipping dot-entries and flagging non-PDF files", () => {
		const cleanDir = join(tempRoot, "clean-folder");
		mkdirSync(join(cleanDir, ".git", "objects"), { recursive: true });
		mkdirSync(join(cleanDir, "sub"), { recursive: true });
		writeFileSync(join(cleanDir, ".DS_Store"), "ignored");
		writeFileSync(join(cleanDir, ".git", "config"), "ignored");
		writeFileSync(join(cleanDir, "doc1.pdf"), "%PDF-1.7\nhello");
		writeFileSync(join(cleanDir, "sub", "doc2.pdf"), "%PDF-1.4\nworld");

		const cleanRes = inspectImportPaths([cleanDir], tempRoot);
		assert.equal(cleanRes.missingPaths.length, 0);
		assert.equal(cleanRes.unexpectedFiles.length, 0);
		assert.equal(cleanRes.validPdfFiles.length, 2);

		const mixedDir = join(tempRoot, "mixed-folder");
		mkdirSync(mixedDir, { recursive: true });
		writeFileSync(join(mixedDir, "good.pdf"), "%PDF-1.7\ncontent");
		writeFileSync(join(mixedDir, "notes.txt"), "not a pdf");
		writeFileSync(join(mixedDir, "guide.md"), "# Guide\nSome markdown notes");

		// By default, directories only allow .pdf
		const mixedRes = inspectImportPaths([mixedDir], tempRoot);
		assert.equal(mixedRes.unexpectedFiles.length, 2);

		// With allow_ext: ["md", "txt"], directory allows .pdf, .md, and .txt
		const allowedDirRes = inspectImportPaths([mixedDir], tempRoot, ["md", "txt"]);
		assert.equal(allowedDirRes.unexpectedFiles.length, 0);
		assert.equal(allowedDirRes.validPdfFiles.length, 3);

		// Single specific .md or .txt file paths do not require allow_ext
		const singleMdTxtRes = inspectImportPaths(
			[join(mixedDir, "notes.txt"), join(mixedDir, "guide.md")],
			tempRoot,
		);
		assert.equal(singleMdTxtRes.unexpectedFiles.length, 0);
		assert.equal(singleMdTxtRes.validPdfFiles.length, 2);
	});

	it("shares original PDFs in objects/ and only cleans up unreferenced objects", async () => {
		const kb1 = await createKb("KB One", tempRoot);
		const samplePdf = join(tempRoot, "sample.pdf");
		writeFileSync(samplePdf, "%PDF-1.7\nsample pdf bytes");

		const { fullHash } = hashFileSha256(samplePdf);
		const objPath1 = ensureSharedOriginalPdf(tempRoot, fullHash, samplePdf);
		const objPath2 = ensureSharedOriginalPdf(tempRoot, fullHash, samplePdf);
		assert.equal(objPath1, objPath2);

		// Reference fullHash in kb1, and create an orphan PDF in objects/
		const orphanHash = "f".repeat(64);
		const orphanPath = join(tempRoot, "objects", `${orphanHash}.pdf`);
		writeFileSync(orphanPath, "%PDF-1.7\norphan");

		saveSourceMeta(tempRoot, kb1.id, {
			fullHash,
			shortHash: fullHash.slice(0, 7),
			originalFilename: "sample.pdf",
			originalPath: samplePdf,
			objectRelPath: `objects/${fullHash}.pdf`,
			fileSize: statSync(samplePdf).size,
			importedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			status: "ready",
			pageCount: 1,
			usableTextPages: 1,
			unreadablePages: [],
			figureCount: 0,
		});

		const cleanup = await cleanupUnreferencedObjects(tempRoot);
		assert.equal(cleanup.deletedCount, 1);
		assert.deepEqual(cleanup.deletedHashes, [orphanHash]);
		assert.equal(cleanup.retainedCount, 1);
		assert.equal(existsSync(objPath1), true);
		assert.equal(existsSync(orphanPath), false);
	});

	it("follows session connection and approval override rules across new, resume, fork, and rewind", () => {
		const mgr = new SessionStateManager();

		// 1. Start a new session -> no connected KBs, no overrides
		mgr.restoreFromBranch({ sessionId: "sess-1", reason: "startup", branchEntries: [] });
		assert.deepEqual(mgr.getConnectedKbs(), []);
		assert.equal(mgr.hasSessionApprovalOverride("connect"), false);

		mgr.connect(["001", "002"]);
		mgr.setSessionApprovalOverride("connect", true);
		mgr.setSessionApprovalOverride("import", true);
		const entryAtPoint1 = {
			type: "custom",
			customType: "realkb-state",
			data: mgr.toEntryData(),
		};

		mgr.disconnect(["002"]);
		const entryAtPoint2 = {
			type: "custom",
			customType: "realkb-state",
			data: mgr.toEntryData(),
		};

		// 2. Resume saved session -> restore connections and overrides
		const resumed = new SessionStateManager();
		resumed.restoreFromBranch({
			sessionId: "sess-1",
			reason: "resume",
			branchEntries: [entryAtPoint1, entryAtPoint2],
		});
		assert.deepEqual(resumed.getConnectedKbs(), ["001"]);
		assert.equal(resumed.hasSessionApprovalOverride("connect"), true);
		assert.equal(resumed.hasSessionApprovalOverride("import"), true);

		// 3. Fork into a new session -> inherit connections at fork point, reset overrides
		const forked = new SessionStateManager();
		const forkRes = forked.restoreFromBranch({
			sessionId: "sess-2-forked",
			reason: "fork",
			branchEntries: [entryAtPoint1],
		});
		assert.equal(forkRes.shouldPersistForkReset, true);
		assert.deepEqual(forked.getConnectedKbs(), ["001", "002"]);
		assert.equal(forked.hasSessionApprovalOverride("connect"), false);
		assert.equal(forked.hasSessionApprovalOverride("import"), false);

		// 4. Rewind within same session -> restore connections and choices at selected point
		resumed.restoreFromBranch({
			sessionId: "sess-1",
			reason: "tree",
			branchEntries: [entryAtPoint1],
		});
		assert.deepEqual(resumed.getConnectedKbs(), ["001", "002"]);
		assert.equal(resumed.hasSessionApprovalOverride("connect"), true);
	});
});
