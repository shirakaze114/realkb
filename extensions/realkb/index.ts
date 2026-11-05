import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import {
	type ApprovalMode,
	configFilePath,
	defaultRealkbDir,
	embeddingFingerprint,
	loadConfig,
	maskSecret,
	normalizeEndpoint,
	type RealkbConfig,
	saveConfig,
} from "../../src/config.ts";
import {
	getSourceInfo,
	linkifyCitationsInMarkdown,
	readFromKb,
	searchConnectedKbs,
} from "../../src/engine.ts";
import {
	formatDuration,
	formatImportBatchSummary,
	formatJobOutcomeSummary,
	formatJobProgressShort,
	type ImportNotificationDetails,
	ImportJobManager,
	installRealkbDock,
	REALKB_NOTIFICATION_TYPE,
	renderImportNotification,
	spinnerFrame,
} from "../../src/import-jobs.ts";
import {
	type ApprovalCategory,
	type BranchEntryLike,
	REALKB_SESSION_ENTRY_TYPE,
	SessionStateManager,
} from "../../src/session-state.ts";
import {
	cleanupUnreferencedObjects,
	createKb,
	ensureStorageDirs,
	inspectImportPaths,
	type KbMeta,
	listKbs,
	listSourcesInKb,
	resolveKb,
} from "../../src/storage.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "..", "skills");

const SUBCOMMANDS: Array<{ name: string; description: string }> = [
	{ name: "list", description: "List local knowledge bases and their session connection status" },
	{ name: "status", description: "List knowledge bases currently connected to this session" },
	{ name: "create", description: "Create a new knowledge base: /realkb create <name>" },
	{ name: "connect", description: "Connect a knowledge base to this session: /realkb connect [id-or-name]" },
	{
		name: "disconnect",
		description: "Disconnect a knowledge base from this session: /realkb disconnect [id-or-name]",
	},
	{
		name: "jobs",
		description: "Show active and recent PDF import jobs and their progress",
	},
	{
		name: "stop",
		description: "Stop a running background PDF import job: /realkb stop [job-id|all]",
	},
	{
		name: "config",
		description: "View or update global realkb settings (approval mode, embedding endpoint/model)",
	},
	{
		name: "cleanup",
		description: "Remove unreferenced shared PDF files in objects/ not used by any KB",
	},
];

function textContent(text: string) {
	const truncated = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	const finalText = truncated.truncated
		? `${truncated.content}\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines]`
		: truncated.content;
	return [{ type: "text" as const, text: finalText }];
}

function buildSystemPromptSection(rootDir: string, connectedKbIds: string[]): string {
	const allKbs = listKbs(rootDir);
	const byId = new Map(allKbs.map((k) => [k.id, k]));
	const connectedKbs = connectedKbIds
		.map((id) => byId.get(id))
		.filter((k): k is KbMeta => Boolean(k));

	const lines: string[] = [
		"Local PDF knowledge bases (`realkb`):",
		`- Storage directory: \`${rootDir}\``,
	];

	if (connectedKbs.length === 0) {
		lines.push(
			"- Connected KBs in this session: none (no KB search/read access until a KB is connected via `realkb_connect` or `/realkb connect`).",
		);
	} else {
		lines.push(
			`- Connected KBs in this session (${connectedKbs.length}): ${connectedKbs.map((k) => `\`${k.id}\` ("${k.name}")`).join(", ")}.`,
		);
	}

	lines.push(
		"- Only connected KBs can be searched (`realkb_search`) or read (`realkb_read`). Use `realkb_list` to see available KBs and `realkb_connect` to connect or disconnect KBs.",
		"- Before calling `realkb_import` on a directory, inspect its contents (including subfolders) and flag any unexpected or non-PDF files; only PDF-only directories (ignoring dot-files/folders like `.DS_Store` and `.git`) may be imported unless `allow_ext` is explicitly passed.",
		"- Always cite facts taken from a knowledge base using bare `[rkb:<kbId>_<shortHash>]` for a document or `[rkb:<kbId>_<shortHash>p<page>]` for a 1-based page (for example, `[rkb:001_c676ea9p7]`). Do NOT wrap `[rkb:...]` in Markdown links or `file://` URLs yourself — Pi's TUI frontend automatically renders bare `[rkb:...]` tags as compact clickable links.",
	);

	return lines.join("\n");
}

export default function realkbExtension(pi: ExtensionAPI): void {
	const sessionState = new SessionStateManager();
	const jobManager = new ImportJobManager(pi);
	let disposeDock: (() => void) | undefined;

	const getRootDir = (): string => defaultRealkbDir();

	const persistSessionState = (): void => {
		pi.appendEntry(REALKB_SESSION_ENTRY_TYPE, sessionState.toEntryData());
	};

	const refreshStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		try {
			const rootDir = getRootDir();
			const allKbs = listKbs(rootDir);
			const existingIds = new Set(allKbs.map((k) => k.id));
			const connected = sessionState.getConnectedKbs().filter((id) => existingIds.has(id));
			const running = jobManager.runningJobs();

			let base: string | undefined;
			if (allKbs.length > 0 || connected.length > 0 || running.length > 0) {
				base = `·📚 ${connected.length}`;
			}

			if (running.length > 0) {
				const jobPart =
					running.length === 1
						? `${spinnerFrame()} ${running[0].id} ${formatJobProgressShort(running[0])}`
						: `${spinnerFrame()} ${running.length} imports`;
				ctx.ui.setStatus("realkb", base ? `${base} ${jobPart}` : `·📚 ${jobPart}`);
			} else {
				ctx.ui.setStatus("realkb", base);
			}
		} catch {
			// ignore status errors if session is closing
		}
	};

	const syncSessionFromContext = (
		ctx: ExtensionContext,
		reason: "startup" | "reload" | "new" | "resume" | "fork" | "tree",
	): void => {
		const sessionId = ctx.sessionManager.getSessionId?.() ?? "";
		const branchEntries = (ctx.sessionManager.getBranch?.() ?? []) as BranchEntryLike[];
		const { shouldPersistForkReset } = sessionState.restoreFromBranch({
			sessionId,
			reason,
			branchEntries,
		});
		if (shouldPersistForkReset) {
			persistSessionState();
		}
		refreshStatus(ctx);
	};

	/**
	 * Ask the user for approval before an agent-initiated action (`connect`/`create` or `import`),
	 * unless global `approvalMode === "yolo"` or the session category override is active.
	 */
	const requestAgentApproval = async (
		ctx: ExtensionContext,
		category: ApprovalCategory,
		promptTitle: string,
		yesOptionLabel: string,
	): Promise<{ approved: boolean; reason?: string }> => {
		const rootDir = getRootDir();
		const cfg = loadConfig(rootDir);
		if (cfg.approvalMode === "yolo" || sessionState.hasSessionApprovalOverride(category)) {
			return { approved: true };
		}

		if (!ctx.hasUI) {
			return {
				approved: false,
				reason:
					'User approval is required (approvalMode is "ask" and no interactive UI is available). Run `/realkb config approval yolo` to allow non-interactive agent actions.',
			};
		}

		const categoryPlural = category === "connect" ? "connections" : "imports";
		const optYes = yesOptionLabel;
		const optNo = "No";
		const optSession = `Yes, and don't ask again for ${categoryPlural} this session`;

		const choice = await ctx.ui.select(promptTitle, [optYes, optNo, optSession]);
		if (!choice || choice === optNo) {
			let reason: string | undefined;
			if (choice === optNo) {
				const inputReason = await ctx.ui.input("Optional reason for declining (press Enter to skip):", "");
				if (inputReason?.trim()) {
					reason = inputReason.trim();
				}
			}
			return { approved: false, reason };
		}

		if (choice === optSession) {
			sessionState.setSessionApprovalOverride(category, true);
			persistSessionState();
		}

		return { approved: true };
	};

	// ---------------------------------------------------------------------------
	// Lifecycle Events
	// ---------------------------------------------------------------------------

	pi.on("resources_discover", () => ({
		skillPaths: [SKILLS_DIR],
	}));

	pi.registerMarkdownTransformer((markdown) => linkifyCitationsInMarkdown(markdown, getRootDir()));

	pi.registerMessageRenderer?.<ImportNotificationDetails>(
		REALKB_NOTIFICATION_TYPE,
		(message, options, theme) => {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
							.join("");
			return renderImportNotification(message.details, text, options.expanded, theme);
		},
	);

	pi.on("session_start", (event, ctx) => {
		jobManager.ctx = ctx;
		ensureStorageDirs(getRootDir());
		syncSessionFromContext(ctx, event.reason);
		disposeDock?.();
		disposeDock = installRealkbDock(jobManager, ctx, () => refreshStatus(ctx));
	});

	pi.on("session_shutdown", () => {
		disposeDock?.();
		disposeDock = undefined;
	});

	pi.on("session_tree", (_event, ctx) => {
		jobManager.ctx = ctx;
		syncSessionFromContext(ctx, "tree");
	});

	pi.on("agent_start", () => {
		jobManager.busy = true;
	});

	pi.on("agent_end", () => {
		jobManager.busy = false;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		jobManager.ctx = ctx;
		const headless = ctx.mode === "print" || ctx.mode === "json";
		if (headless) {
			const started = Date.now();
			while (
				jobManager.runningJobs().some((j) => j.background) &&
				!jobManager.hasHeldWake() &&
				Date.now() - started < 300_000
			) {
				await new Promise((r) => setTimeout(r, 250));
			}
		}
		const msg = jobManager.takeForSettle();
		if (!msg) return undefined;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: REALKB_NOTIFICATION_TYPE,
					content: msg.content,
					display: true,
					details: msg.details,
				},
			],
			continue: true,
		};
	});

	pi.on("before_agent_start", (event) => {
		const rootDir = getRootDir();
		event.systemPromptOptions.sections.realkb = buildSystemPromptSection(
			rootDir,
			sessionState.getConnectedKbs(),
		);
	});

	// ---------------------------------------------------------------------------
	// Agent-Facing Tools (realkb_*)
	// ---------------------------------------------------------------------------

	const reg = <T extends TSchema>(def: ToolDefinition<T>): void => {
		pi.registerTool(def);
	};

	reg({
		name: "realkb_list",
		label: "realkb list",
		description:
			"List local knowledge bases (ID, name, and whether each KB is connected to the current session). Does not expose document titles or contents of disconnected KBs.",
		promptSnippet: "List local PDF knowledge bases and their current-session connection status",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const rootDir = getRootDir();
			const kbs = listKbs(rootDir);
			const connectedSet = new Set(sessionState.getConnectedKbs());

			if (kbs.length === 0) {
				return {
					content: textContent(
						"No knowledge bases exist yet in ~/.pi/agent/realkb. Create one with `realkb_create` or `/realkb create <name>`.",
					),
					details: { kbs: [], connectedKbs: [] },
				};
			}

			const lines: string[] = [`Local knowledge bases (${kbs.length}):`];
			const items = kbs.map((kb) => {
				const connected = connectedSet.has(kb.id);
				let extra = "";
				if (connected) {
					const sources = listSourcesInKb(rootDir, kb.id);
					const readyCount = sources.filter((s) => s.status === "ready").length;
					const failedCount = sources.filter((s) => s.status !== "ready").length;
					extra = ` · ${readyCount} ready source(s)${failedCount > 0 ? `, ${failedCount} unfinished/failed` : ""}`;
				}
				lines.push(`- ${kb.id}: "${kb.name}" [${connected ? "connected" : "disconnected"}]${extra}`);
				return {
					id: kb.id,
					name: kb.name,
					connected,
				};
			});

			refreshStatus(ctx);
			return {
				content: textContent(lines.join("\n")),
				details: {
					kbs: items,
					connectedKbs: sessionState.getConnectedKbs(),
				},
			};
		},
	});

	reg({
		name: "realkb_create",
		label: "realkb create",
		description:
			"Create a new local PDF knowledge base with a permanent numeric ID (e.g. 001, 002). Asks the user for approval by default and connects the new KB to the current session unless connect=false.",
		promptSnippet: "Create a new PDF knowledge base",
		parameters: Type.Object({
			name: Type.String({
				minLength: 1,
				maxLength: 120,
				description: "Human-readable name for the new knowledge base",
			}),
			connect: Type.Optional(
				Type.Boolean({
					description: "Whether to connect the newly created KB to the current session (default: true)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const rootDir = getRootDir();
			const name = params.name.trim();
			if (!name) {
				throw new Error("Knowledge base name must not be empty.");
			}
			const existing = listKbs(rootDir).find((k) => k.name.toLowerCase() === name.toLowerCase());
			if (existing) {
				throw new Error(`Knowledge base "${existing.name}" already exists with ID ${existing.id}.`);
			}

			const shouldConnect = params.connect !== false;
			const approval = await requestAgentApproval(
				ctx,
				"connect",
				`Create knowledge base "${name}"${shouldConnect ? " and connect it to this session" : ""}?`,
				`Yes, create "${name}"${shouldConnect ? " and connect it" : ""}`,
			);
			if (!approval.approved) {
				const reasonSuffix = approval.reason ? `: ${approval.reason}` : ".";
				return {
					content: textContent(`User declined creating knowledge base "${name}"${reasonSuffix}`),
					details: { declined: true, reason: approval.reason },
				};
			}

			const kb = await createKb(name, rootDir);
			if (shouldConnect) {
				sessionState.connect([kb.id]);
				persistSessionState();
			}
			refreshStatus(ctx);

			return {
				content: textContent(
					`Created knowledge base ${kb.id} ("${kb.name}")${shouldConnect ? " and connected it to the current session." : "."}`,
				),
				details: {
					kb,
					connected: shouldConnect,
				},
			};
		},
	});

	reg({
		name: "realkb_connect",
		label: "realkb connect",
		description:
			"Connect or disconnect one or more knowledge bases (by ID like '001' or by name) for the current session. Connecting asks for user approval by default.",
		promptSnippet: "Connect or disconnect knowledge bases for the current session",
		parameters: Type.Object({
			kbs: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 32,
				description: "KB IDs (e.g. '001') or names to connect or disconnect",
			}),
			action: Type.Optional(
				StringEnum(["connect", "disconnect"] as const, {
					description: "Whether to 'connect' (default) or 'disconnect' the specified KBs",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const rootDir = getRootDir();
			const action = params.action ?? "connect";
			const resolvedKbs: KbMeta[] = [];
			const seenIds = new Set<string>();

			for (const raw of params.kbs) {
				const kb = resolveKb(rootDir, raw);
				if (!kb) {
					throw new Error(`Knowledge base "${raw}" was not found. Call realkb_list to see available KBs.`);
				}
				if (!seenIds.has(kb.id)) {
					seenIds.add(kb.id);
					resolvedKbs.push(kb);
				}
			}

			if (action === "disconnect") {
				const changed = sessionState.disconnect(resolvedKbs.map((k) => k.id));
				if (changed) {
					persistSessionState();
				}
				refreshStatus(ctx);
				return {
					content: textContent(
						`Disconnected KB(s): ${resolvedKbs.map((k) => `${k.id} ("${k.name}")`).join(", ")}.\nCurrently connected: ${sessionState.getConnectedKbs().join(", ") || "none"}.`,
					),
					details: {
						action: "disconnect",
						kbs: resolvedKbs,
						connectedKbs: sessionState.getConnectedKbs(),
					},
				};
			}

			const needed = resolvedKbs.filter((k) => !sessionState.isConnected(k.id));
			if (needed.length === 0) {
				return {
					content: textContent(
						`Already connected to: ${resolvedKbs.map((k) => `${k.id} ("${k.name}")`).join(", ")}.`,
					),
					details: {
						action: "connect",
						kbs: resolvedKbs,
						connectedKbs: sessionState.getConnectedKbs(),
					},
				};
			}

			const labelList = needed.map((k) => `${k.id} ("${k.name}")`).join(", ");
			const approval = await requestAgentApproval(
				ctx,
				"connect",
				`Connect knowledge base(s) ${labelList} to this session?`,
				`Yes, connect ${labelList}`,
			);
			if (!approval.approved) {
				const reasonSuffix = approval.reason ? `: ${approval.reason}` : ".";
				return {
					content: textContent(`User declined connecting knowledge base(s) ${labelList}${reasonSuffix}`),
					details: { declined: true, reason: approval.reason },
				};
			}

			sessionState.connect(needed.map((k) => k.id));
			persistSessionState();
			refreshStatus(ctx);

			return {
				content: textContent(
					`Connected KB(s): ${resolvedKbs.map((k) => `${k.id} ("${k.name}")`).join(", ")}.\nCurrently connected: ${sessionState.getConnectedKbs().join(", ")}.`,
				),
				details: {
					action: "connect",
					kbs: resolvedKbs,
					connectedKbs: sessionState.getConnectedKbs(),
				},
			};
		},
	});

	reg({
		name: "realkb_import",
		label: "realkb import",
		description:
			"Import files (`.pdf`, `.md`, `.txt`) or directories (recursively) into an explicit target knowledge base. Single specific file paths (`.pdf`, `.md`, `.txt`) are imported directly without needing `allow_ext`. Directories only import `.pdf` files by default unless `allow_ext` (e.g. `['md', 'txt']`) is specified; any disallowed files in a directory are rejected. Asks for user approval by default and connects the target KB if not already connected. Automatically runs in the background when importing 2 or more files (or when `run_in_background: true`), showing live progress in the TUI dock and delivering one `<realkb-notification>` when finished.",
		promptSnippet: "Import .pdf, .md, or .txt files or directories into an explicit target KB (background by default for 2+ files)",
		promptGuidelines: [
			"Before calling realkb_import on a directory, inspect its contents (including subfolders). Directories only allow `.pdf` by default; pass `allow_ext: ['md', 'txt']` if the user wants `.md` or `.txt` files from a directory, and flag any unexpected files rather than importing a mixed directory.",
			"Single specific `.pdf`, `.md`, or `.txt` file paths do not require `allow_ext`.",
			"realkb_import defaults to `run_in_background: true` when importing 2+ files (or if a single file exceeds `timeout`), sending a `<realkb-notification>` when finished; do not poll in a loop while waiting.",
		],
		parameters: Type.Object({
			kb: Type.String({
				minLength: 1,
				description: "Explicit target KB ID (e.g. '001') or KB name. Never guess the target KB.",
			}),
			paths: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 128,
				description: "File paths (.pdf, .md, .txt) or directory paths to import (relative to cwd or absolute)",
			}),
			allow_ext: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					maxItems: 8,
					description:
						"Additional file extensions to allow when importing directories (e.g. ['md', 'txt']). By default, directories only allow .pdf files. Single file paths (.pdf, .md, .txt) do not need allow_ext.",
				}),
			),
			run_in_background: Type.Optional(
				Type.Boolean({
					description:
						"Run the import in the background after approval and return the job ID immediately (defaults to true when importing >= 2 files, false for 1 file). You will receive a <realkb-notification> when it finishes.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 600,
					description:
						"Seconds to wait in the foreground before automatically moving the import to the background (default: 15).",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			jobManager.ctx = ctx;
			const rootDir = getRootDir();
			const kb = resolveKb(rootDir, params.kb);
			if (!kb) {
				throw new Error(
					`Target knowledge base "${params.kb}" was not found. Call realkb_list or realkb_create first.`,
				);
			}

			// Validate paths before asking for user approval so mixed directories or missing files fail early
			const inspection = inspectImportPaths(params.paths, ctx.cwd, params.allow_ext);
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
					`Refusing to import mixed or disallowed directory contents. Inspect and clean up unexpected files (or pass allow_ext for .md/.txt in directories): ${details}${more}`,
				);
			}
			if (inspection.validPdfFiles.length === 0) {
				throw new Error("No importable files were found in the specified path(s).");
			}

			const cfg = loadConfig(rootDir);
			const endpointDisplay = normalizeEndpoint(cfg.embedding.endpoint) || "(unconfigured endpoint)";
			const modelDisplay = cfg.embedding.model.trim() || "(unconfigured model)";
			const willConnect = !sessionState.isConnected(kb.id);

			const filePreview = inspection.validPdfFiles
				.slice(0, 5)
				.map((p) => `• ${p}`)
				.join("\n");
			const moreFiles =
				inspection.validPdfFiles.length > 5
					? `\n• ...and ${inspection.validPdfFiles.length - 5} more file(s)`
					: "";

			const promptTitle = [
				`Import ${inspection.validPdfFiles.length} file(s) into KB ${kb.id} ("${kb.name}")${willConnect ? " and connect it to this session" : ""}?`,
				filePreview + moreFiles,
				`Notice: Extracted text will be sent to the configured embedding API (${endpointDisplay} · model: ${modelDisplay}).`,
			].join("\n");

			const approval = await requestAgentApproval(
				ctx,
				"import",
				promptTitle,
				`Yes, import ${inspection.validPdfFiles.length} file(s) and send extracted text to embedding API`,
			);
			if (!approval.approved) {
				const reasonSuffix = approval.reason ? `: ${approval.reason}` : ".";
				return {
					content: textContent(
						`User declined importing ${inspection.validPdfFiles.length} file(s) into KB ${kb.id} ("${kb.name}")${reasonSuffix}`,
					),
					details: { declined: true, reason: approval.reason },
				};
			}

			// Connect target KB if not already connected, as part of an approved import
			if (willConnect) {
				sessionState.connect([kb.id]);
				persistSessionState();
				refreshStatus(ctx);
			}

			const runInBg = params.run_in_background ?? inspection.validPdfFiles.length >= 2;
			const job = jobManager.startJob({
				kb,
				paths: params.paths,
				allowExt: params.allow_ext,
				validFileCount: inspection.validPdfFiles.length,
				cwd: ctx.cwd,
				rootDir,
				config: cfg,
				background: runInBg,
			});
			refreshStatus(ctx);

			if (runInBg) {
				return {
					content: textContent(
						`Started background import job ${job.id} into KB ${kb.id} ("${kb.name}") for ${inspection.validPdfFiles.length} file(s).\n` +
							`Live progress is shown in the TUI dock and status bar (\`/realkb jobs\` to inspect, \`/realkb stop ${job.id}\` to cancel).\n` +
							"You will receive one `<realkb-notification>` when the import finishes; do not poll in a loop.",
					),
					details: {
						jobId: job.id,
						status: "running",
						background: true,
						kb,
						totalFiles: inspection.validPdfFiles.length,
					},
				};
			}

			// Foreground execution with live progress updates and automatic background promotion on timeout
			const windowMs = Math.min(600_000, Math.max(1000, Math.round((params.timeout ?? 15) * 1000)));
			let promotedToBg = false;

			const emitProgressUpdate = () => {
				if (!onUpdate || promotedToBg || job.status !== "running") return;
				const elapsed = formatDuration(Date.now() - job.startedAt);
				onUpdate({
					content: textContent(
						`realkb (${job.id} → KB ${kb.id} "${kb.name}"): ${formatJobProgressShort(job)} · ${elapsed}`,
					),
					details: {
						jobId: job.id,
						status: "running",
						progress: job.progress,
					},
				});
			};

			emitProgressUpdate();
			const offChange = jobManager.onChange(emitProgressUpdate);
			const updateTimer = onUpdate ? setInterval(emitProgressUpdate, 250) : undefined;
			updateTimer?.unref?.();

			const onAbort = () => {
				if (!promotedToBg && job.status === "running") {
					job.abortController.abort(signal?.reason ?? new Error("Import aborted"));
				}
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });

			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<"timeout">((resolve) => {
				timeoutTimer = setTimeout(() => resolve("timeout"), windowMs);
				timeoutTimer.unref?.();
			});

			try {
				const runPromise = job.promise;
				if (!runPromise) {
					throw new Error(`Import job ${job.id} failed to initialize.`);
				}
				const outcome = await Promise.race([
					runPromise.then((batch) => ({ kind: "done" as const, batch })),
					timeoutPromise.then(() => ({ kind: "timeout" as const })),
				]);

				if (outcome.kind === "timeout" && job.status === "running") {
					promotedToBg = true;
					jobManager.promoteToBackground(job);
					refreshStatus(ctx);
					return {
						content: textContent(
							`Import job ${job.id} into KB ${kb.id} ("${kb.name}") is still running after ${formatDuration(windowMs)} (${formatJobProgressShort(job)}) and continues in the background.\n` +
								`Check \`/realkb jobs\` or wait for the \`<realkb-notification>\` wakeup when it finishes.`,
						),
						details: {
							jobId: job.id,
							status: "running",
							background: true,
							promotedAfterMs: windowMs,
							kb,
							progress: job.progress,
						},
					};
				}

				const batch = outcome.kind === "done" ? outcome.batch : await runPromise;
				refreshStatus(ctx);
				return {
					content: textContent(formatImportBatchSummary(rootDir, kb, batch)),
					details: batch,
				};
			} finally {
				offChange();
				if (updateTimer) clearInterval(updateTimer);
				if (timeoutTimer) clearTimeout(timeoutTimer);
				signal?.removeEventListener("abort", onAbort);
				refreshStatus(ctx);
			}
		},
	});

	reg({
		name: "realkb_search",
		label: "realkb search",
		description:
			"Search connected knowledge bases (or a specified subset of connected KBs) using hybrid semantic vector + BM25 keyword retrieval. Returns original-text passages with chunk indices, page numbers, and `[rkb:...]` citations.",
		promptSnippet: "Hybrid vector + keyword search across connected PDF knowledge bases",
		promptGuidelines: [
			"Cite every fact from realkb_search or realkb_read with its bare page citation (e.g. `[rkb:001_c676ea9p7]`). Never write `file://` URLs or Markdown links around `[rkb:...]` yourself; Pi's frontend automatically transforms bare `[rkb:...]` citations into clickable links.",
		],
		parameters: Type.Object({
			query: Type.String({
				minLength: 1,
				maxLength: 1000,
				description: "Natural-language question or keywords to search for",
			}),
			kbs: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					maxItems: 32,
					description: "Optional subset of connected KB IDs or names to search",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 25,
					description: "Maximum number of passages to return (default: 8)",
				}),
			),
		}),
		async execute(_id, params, signal) {
			const rootDir = getRootDir();
			const res = await searchConnectedKbs({
				query: params.query,
				connectedKbIds: sessionState.getConnectedKbs(),
				filterKbIds: params.kbs,
				limit: params.limit,
				rootDir,
				signal,
			});

			const lines: string[] = [];
			if (res.warnings.length > 0) {
				for (const w of res.warnings) {
					lines.push(`⚠ Note: ${w}`);
				}
				lines.push("");
			}

			if (res.hits.length === 0) {
				lines.push(
					`No matching passages found for "${res.query}" in connected KB(s): ${res.searchedKbs.map((k) => `${k.id} ("${k.name}")`).join(", ")}.`,
				);
				return {
					content: textContent(lines.join("\n")),
					details: res,
				};
			}

			lines.push(
				`Found ${res.hits.length} passage(s) across ${res.searchedKbs.map((k) => `${k.id} ("${k.name}")`).join(", ")}:`,
			);

			for (let i = 0; i < res.hits.length; i++) {
				const h = res.hits[i];
				const rawCitations = h.citations.join(" ");
				const chunkLabel =
					h.chunkIndices.length === 1
						? `chunk #${h.chunkIndices[0]}`
						: `chunks #${h.chunkIndices.join(", #")}`;
				const pageRangeLabel =
					h.pageStart === h.pageEnd ? `p.${h.pageStart}` : `pp.${h.pageStart}-${h.pageEnd}`;

				lines.push(
					"",
					`--- [${i + 1}] ${rawCitations} · "${h.filename}" (KB ${h.kbId} "${h.kbName}", ${chunkLabel}, ${pageRangeLabel}) ---`,
					h.text,
				);
			}

			return {
				content: textContent(lines.join("\n")),
				details: res,
			};
		},
	});

	reg({
		name: "realkb_read",
		label: "realkb read",
		description:
			"Read a passage (by chunk index ± neighbors) or a PDF page / page range from a connected knowledge base. Accepts citation syntax (`[rkb:001_c676ea9p7]`, `001_c676ea9p7`) or colon syntax (`001:c676ea9p7`).",
		promptSnippet: "Read surrounding chunks or PDF pages for a source in a connected KB",
		parameters: Type.Object({
			ref: Type.String({
				minLength: 5,
				description:
					"Source or page reference: e.g. '[rkb:001_c676ea9p7]', '001_c676ea9p7', '001_c676ea9', or '001:c676ea9p7'",
			}),
			chunk: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: "Optional 0-based chunk_index to read (fetches chunk ± neighbors)",
				}),
			),
			neighbors: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: 5,
					description: "Number of neighboring chunks before and after `chunk` to include (default: 1)",
				}),
			),
			pageStart: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Optional 1-based start page number (overrides page suffix in ref)",
				}),
			),
			pageEnd: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Optional 1-based end page number for reading a page range",
				}),
			),
		}),
		async execute(_id, params) {
			const rootDir = getRootDir();
			const res = readFromKb({
				ref: params.ref,
				connectedKbIds: sessionState.getConnectedKbs(),
				chunk: params.chunk,
				neighbors: params.neighbors,
				pageStart: params.pageStart,
				pageEnd: params.pageEnd,
				rootDir,
			});

			const lines: string[] = [
				`Source: ${res.documentCitation} "${res.source.originalFilename}" — KB ${res.kb.id} ("${res.kb.name}")`,
			];

			if (res.source.unreadablePages.length > 0) {
				lines.push(
					`⚠ Note: This PDF has ${res.source.unreadablePages.length} scanned/unreadable page(s) without selectable text: p.${res.source.unreadablePages.slice(0, 15).join(", p.")}`,
				);
			}

			for (const p of res.passages) {
				lines.push("", `=== ${p.label} · ${p.citation} ===`, p.text);
			}

			return {
				content: textContent(lines.join("\n")),
				details: res,
			};
		},
	});

	reg({
		name: "realkb_source_info",
		label: "realkb source info",
		description:
			"Resolve a specific source reference (`001_c676ea9`, `[rkb:001_c676ea9p7]`, or `001:c676ea9`) and return its metadata, extraction coverage, and stored original file path. Works even if that KB is not currently connected, without connecting the KB or granting search/read access.",
		promptSnippet: "Resolve a citation or source reference to its original file path and metadata",
		parameters: Type.Object({
			ref: Type.String({
				minLength: 5,
				description: "Source or page reference: e.g. '001_c676ea9', '[rkb:001_c676ea9p7]', or '001:c676ea9'",
			}),
		}),
		async execute(_id, params) {
			const rootDir = getRootDir();
			const info = getSourceInfo(params.ref, rootDir);

			const lines: string[] = [
				`Source Reference: ${info.citation}`,
				`Knowledge Base: ${info.kb.id} ("${info.kb.name}") [${sessionState.isConnected(info.kb.id) ? "connected" : "disconnected"}]`,
				`Original Filename: ${info.source.originalFilename}`,
				`Status: ${info.source.status}${info.source.failingStep ? ` (failed at ${info.source.failingStep}: ${info.source.error ?? ""})` : ""}`,
				`Stored Original File: ${info.pdfPath}`,
				`SHA-256: ${info.source.fullHash} (short hash: ${info.source.shortHash})`,
				`Page Coverage: ${info.source.usableTextPages}/${info.source.pageCount} page(s) with selectable text, ${info.source.figureCount} figure marker(s), ${info.source.chunkCount ?? 0} indexed chunk(s)`,
			];

			if (info.source.unreadablePages.length > 0) {
				lines.push(
					`Unreadable / Scanned Pages: p.${info.source.unreadablePages.join(", p.")}`,
				);
			}

			return {
				content: textContent(lines.join("\n")),
				details: info,
			};
		},
	});

	// ---------------------------------------------------------------------------
	// User Slash Command (/realkb)
	// ---------------------------------------------------------------------------

	const handleConfigCommand = async (restArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
		const rootDir = getRootDir();
		const cfg = loadConfig(rootDir);
		const tokens = restArgs.trim().split(/\s+/).filter(Boolean);

		const formatConfigSummary = (c: RealkbConfig): string => {
			const overrides = sessionState.getApprovalOverrides();
			const activeOverrides = [
				overrides.connect ? "connections" : "",
				overrides.import ? "imports" : "",
			].filter(Boolean);

			return [
				`realkb configuration (${configFilePath(rootDir)}):`,
				`  approvalMode: ${c.approvalMode} (session overrides: ${activeOverrides.length > 0 ? activeOverrides.join(", ") : "none"})`,
				`  embedding.endpoint: ${normalizeEndpoint(c.embedding.endpoint) || "(not set)"}`,
				`  embedding.model: ${c.embedding.model || "(not set)"}`,
				`  embedding.apiKey: ${maskSecret(c.embedding.apiKey)}`,
				`  embedding.dimensions: ${c.embedding.dimensions}`,
				`  embedding.batchSize: ${c.embedding.batchSize}`,
				`  embedding.timeoutMs: ${c.embedding.timeoutMs}`,
				`  embedding.fingerprint: ${embeddingFingerprint(c)}`,
			].join("\n");
		};

		if (tokens.length > 0) {
			const key = tokens[0].toLowerCase();
			const val = tokens.slice(1).join(" ").trim();

			if (key === "approval" || key === "approvalmode") {
				if (val !== "ask" && val !== "yolo") {
					ctx.ui.notify('Usage: /realkb config approval <ask|yolo>', "warning");
					return;
				}
				cfg.approvalMode = val as ApprovalMode;
				saveConfig(cfg, rootDir);
				ctx.ui.notify(`realkb: saved global approvalMode = "${val}"`, "info");
				return;
			}
			if (key === "endpoint") {
				cfg.embedding.endpoint = val;
				saveConfig(cfg, rootDir);
				ctx.ui.notify(
					`realkb: saved embedding.endpoint = "${normalizeEndpoint(cfg.embedding.endpoint) || "(none)"}"`,
					"info",
				);
				return;
			}
			if (key === "model") {
				cfg.embedding.model = val;
				saveConfig(cfg, rootDir);
				ctx.ui.notify(`realkb: saved embedding.model = "${cfg.embedding.model || "(none)"}"`, "info");
				return;
			}
			if (key === "api-key" || key === "apikey") {
				cfg.embedding.apiKey = val;
				saveConfig(cfg, rootDir);
				ctx.ui.notify(`realkb: saved embedding.apiKey = ${maskSecret(cfg.embedding.apiKey)}`, "info");
				return;
			}
			if (key === "dimensions" || key === "dim") {
				const n = Number.parseInt(val, 10);
				if (!Number.isInteger(n) || n < 32 || n > 8192) {
					ctx.ui.notify("Usage: /realkb config dimensions <32..8192>", "warning");
					return;
				}
				cfg.embedding.dimensions = n;
				saveConfig(cfg, rootDir);
				ctx.ui.notify(`realkb: saved embedding.dimensions = ${cfg.embedding.dimensions}`, "info");
				return;
			}
			if (key === "reset-session-approvals") {
				sessionState.resetSessionApprovalOverrides();
				persistSessionState();
				ctx.ui.notify("realkb: reset session-only approval overrides to global settings", "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /realkb config [approval <ask|yolo> | endpoint <url> | model <id> | api-key <$ENV_VAR|key> | dimensions <n> | reset-session-approvals]",
				"info",
			);
			return;
		}

		if (!ctx.hasUI) {
			ctx.ui.notify(formatConfigSummary(cfg), "info");
			return;
		}

		for (;;) {
			const overrides = sessionState.getApprovalOverrides();
			const activeOverrides = [
				overrides.connect ? "connections" : "",
				overrides.import ? "imports" : "",
			].filter(Boolean);

			const menuItems = [
				`Global approval mode: ${cfg.approvalMode} (toggle ask / yolo)`,
				`Embedding endpoint: ${normalizeEndpoint(cfg.embedding.endpoint) || "(not set)"}`,
				`Embedding model: ${cfg.embedding.model || "(not set)"}`,
				`Embedding API key: ${maskSecret(cfg.embedding.apiKey)}`,
				`Embedding dimensions: ${cfg.embedding.dimensions}`,
				`Query instruction: ${cfg.embedding.queryInstruction ? "configured" : "(empty)"}`,
				`Reset session approval overrides (${activeOverrides.length > 0 ? activeOverrides.join(", ") : "none"})`,
				"Done",
			];

			const pick = await ctx.ui.select("realkb configuration", menuItems);
			if (!pick || pick === "Done") break;

			if (pick.startsWith("Global approval mode:")) {
				cfg.approvalMode = cfg.approvalMode === "ask" ? "yolo" : "ask";
				saveConfig(cfg, rootDir);
				ctx.ui.notify(`realkb: global approvalMode set to "${cfg.approvalMode}"`, "info");
			} else if (pick.startsWith("Embedding endpoint:")) {
				const next = await ctx.ui.input(
					"OpenAI-compatible embedding base URL (e.g. https://api.openai.com/v1):",
					cfg.embedding.endpoint,
				);
				if (next !== undefined) {
					cfg.embedding.endpoint = next.trim();
					saveConfig(cfg, rootDir);
				}
			} else if (pick.startsWith("Embedding model:")) {
				const next = await ctx.ui.input(
					"Embedding model ID (e.g. text-embedding-3-large or Qwen/Qwen3-Embedding-8B):",
					cfg.embedding.model,
				);
				if (next !== undefined) {
					cfg.embedding.model = next.trim();
					saveConfig(cfg, rootDir);
				}
			} else if (pick.startsWith("Embedding API key:")) {
				const next = await ctx.ui.input(
					"API key or env variable reference (e.g. $OPENAI_API_KEY or env:OPENAI_API_KEY):",
					cfg.embedding.apiKey.startsWith("$") || cfg.embedding.apiKey.startsWith("env:")
						? cfg.embedding.apiKey
						: "",
				);
				if (next !== undefined) {
					cfg.embedding.apiKey = next.trim();
					saveConfig(cfg, rootDir);
				}
			} else if (pick.startsWith("Embedding dimensions:")) {
				const next = await ctx.ui.input(
					"Embedding vector dimensions (32..8192):",
					String(cfg.embedding.dimensions),
				);
				if (next !== undefined) {
					const parsed = Number.parseInt(next.trim(), 10);
					if (Number.isInteger(parsed) && parsed >= 32 && parsed <= 8192) {
						cfg.embedding.dimensions = parsed;
						saveConfig(cfg, rootDir);
					} else {
						ctx.ui.notify("Dimensions must be an integer between 32 and 8192.", "warning");
					}
				}
			} else if (pick.startsWith("Query instruction:")) {
				const next = await ctx.ui.input(
					"Query instruction prefix (leave empty for none):",
					cfg.embedding.queryInstruction,
				);
				if (next !== undefined) {
					cfg.embedding.queryInstruction = next;
					saveConfig(cfg, rootDir);
				}
			} else if (pick.startsWith("Reset session approval overrides")) {
				sessionState.resetSessionApprovalOverrides();
				persistSessionState();
				ctx.ui.notify("realkb: reset session approval overrides", "info");
			}
		}
	};

	pi.registerCommand("realkb", {
		description: "Manage PDF knowledge bases: create, connect, disconnect, list, config, cleanup",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trimStart();
			if (!trimmed.includes(" ")) {
				const lower = trimmed.toLowerCase();
				const matches = SUBCOMMANDS.filter((s) => s.name.startsWith(lower)).map((s) => ({
					value: s.name,
					label: s.name,
					description: s.description,
				}));
				return matches.length > 0 ? matches : null;
			}

			const [sub, ...rest] = trimmed.split(/\s+/);
			const subLower = sub.toLowerCase();
			const argPrefix = rest.join(" ").toLowerCase();
			if (subLower === "connect" || subLower === "disconnect") {
				const rootDir = getRootDir();
				const kbs = listKbs(rootDir);
				const filtered = kbs
					.filter((k) =>
						subLower === "connect" ? !sessionState.isConnected(k.id) : sessionState.isConnected(k.id),
					)
					.filter(
						(k) =>
							k.id.startsWith(argPrefix) || k.name.toLowerCase().includes(argPrefix),
					)
					.map((k) => ({
						value: `${subLower} ${k.id}`,
						label: `${k.id} (${k.name})`,
						description: subLower === "connect" ? "Connect to this session" : "Disconnect from this session",
					}));
				return filtered.length > 0 ? filtered : null;
			}
			if (subLower === "stop") {
				const running = jobManager.runningJobs();
				const options = ["all", ...running.map((j) => j.id)].filter((o) =>
					o.toLowerCase().startsWith(argPrefix),
				);
				return options.length > 0
					? options.map((o) => ({ value: `stop ${o}`, label: o }))
					: null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const rootDir = getRootDir();
			ensureStorageDirs(rootDir);
			const trimmed = args.trim();
			const spaceIdx = trimmed.indexOf(" ");
			const sub = (spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase() || "list";
			const rest = spaceIdx < 0 ? "" : trimmed.slice(spaceIdx + 1).trim();

			if (sub === "list") {
				const kbs = listKbs(rootDir);
				if (kbs.length === 0) {
					ctx.ui.notify(
						"realkb: no knowledge bases exist yet. Create one with `/realkb create <name>`.",
						"info",
					);
					return;
				}
				const connectedSet = new Set(sessionState.getConnectedKbs());
				const lines = kbs.map((kb) => {
					const connected = connectedSet.has(kb.id);
					const sources = listSourcesInKb(rootDir, kb.id);
					const ready = sources.filter((s) => s.status === "ready").length;
					const failed = sources.length - ready;
					return `• ${kb.id} "${kb.name}" [${connected ? "connected" : "disconnected"}] — ${ready} ready source(s)${failed > 0 ? `, ${failed} failed/unfinished` : ""}`;
				});
				ctx.ui.notify(`realkb knowledge bases (${kbs.length}):\n${lines.join("\n")}`, "info");
				refreshStatus(ctx);
				return;
			}

			if (sub === "create") {
				let name = rest;
				if (!name && ctx.hasUI) {
					const input = await ctx.ui.input("New knowledge base name:", "");
					name = input?.trim() ?? "";
				}
				if (!name) {
					ctx.ui.notify("Usage: /realkb create <name>", "warning");
					return;
				}
				try {
					const kb = await createKb(name, rootDir);
					sessionState.connect([kb.id]);
					persistSessionState();
					refreshStatus(ctx);
					ctx.ui.notify(
						`realkb: created knowledge base ${kb.id} ("${kb.name}") and connected it to this session.`,
						"info",
					);
				} catch (err) {
					ctx.ui.notify(
						`realkb: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
				return;
			}

			if (sub === "connect") {
				const kbs = listKbs(rootDir);
				if (kbs.length === 0) {
					ctx.ui.notify(
						"realkb: no knowledge bases exist yet. Run `/realkb create <name>` first.",
						"warning",
					);
					return;
				}

				let target = rest;
				if (!target && ctx.hasUI) {
					const disconnected = kbs.filter((k) => !sessionState.isConnected(k.id));
					if (disconnected.length === 0) {
						ctx.ui.notify("realkb: all knowledge bases are already connected to this session.", "info");
						return;
					}
					const options = disconnected.map((k) => `${k.id} — ${k.name}`);
					const pick = await ctx.ui.select("Select a knowledge base to connect:", options);
					if (!pick) return;
					target = pick.split(" — ")[0].trim();
				}

				if (!target) {
					ctx.ui.notify("Usage: /realkb connect <id-or-name>", "warning");
					return;
				}

				const kb = resolveKb(rootDir, target);
				if (!kb) {
					ctx.ui.notify(`realkb: knowledge base "${target}" was not found.`, "error");
					return;
				}

				if (sessionState.connect([kb.id])) {
					persistSessionState();
				}
				refreshStatus(ctx);
				ctx.ui.notify(`realkb: connected ${kb.id} ("${kb.name}") to this session.`, "info");
				return;
			}

			if (sub === "disconnect") {
				const kbs = listKbs(rootDir);
				const connectedKbs = kbs.filter((k) => sessionState.isConnected(k.id));
				if (connectedKbs.length === 0) {
					ctx.ui.notify("realkb: no knowledge bases are currently connected to this session.", "info");
					return;
				}

				let target = rest;
				if (!target && ctx.hasUI) {
					const options = [
						...connectedKbs.map((k) => `${k.id} — ${k.name}`),
						...(connectedKbs.length > 1 ? ["All connected KBs"] : []),
					];
					const pick = await ctx.ui.select("Select a knowledge base to disconnect:", options);
					if (!pick) return;
					if (pick === "All connected KBs") {
						sessionState.disconnect(connectedKbs.map((k) => k.id));
						persistSessionState();
						refreshStatus(ctx);
						ctx.ui.notify("realkb: disconnected all knowledge bases from this session.", "info");
						return;
					}
					target = pick.split(" — ")[0].trim();
				}

				if (!target) {
					ctx.ui.notify("Usage: /realkb disconnect <id-or-name>", "warning");
					return;
				}

				if (target.toLowerCase() === "all") {
					sessionState.disconnect(sessionState.getConnectedKbs());
					persistSessionState();
					refreshStatus(ctx);
					ctx.ui.notify("realkb: disconnected all knowledge bases from this session.", "info");
					return;
				}

				const kb = resolveKb(rootDir, target);
				if (!kb) {
					ctx.ui.notify(`realkb: knowledge base "${target}" was not found.`, "error");
					return;
				}

				if (sessionState.disconnect([kb.id])) {
					persistSessionState();
				}
				refreshStatus(ctx);
				ctx.ui.notify(`realkb: disconnected ${kb.id} ("${kb.name}") from this session.`, "info");
				return;
			}

			if (sub === "status") {
				const kbs = listKbs(rootDir);
				const connectedSet = new Set(sessionState.getConnectedKbs());
				const connectedKbs = kbs.filter((kb) => connectedSet.has(kb.id));
				if (connectedKbs.length === 0) {
					ctx.ui.notify(
						"realkb: no knowledge bases are connected to this session. Connect one with `/realkb connect [id-or-name]`.",
						"info",
					);
					refreshStatus(ctx);
					return;
				}
				const lines = connectedKbs.map((kb) => {
					const sources = listSourcesInKb(rootDir, kb.id);
					const ready = sources.filter((s) => s.status === "ready").length;
					const failed = sources.length - ready;
					return `• ${kb.id} "${kb.name}" [connected] — ${ready} ready source(s)${failed > 0 ? `, ${failed} failed/unfinished` : ""}`;
				});
				ctx.ui.notify(
					`realkb connected knowledge bases (${connectedKbs.length}):\n${lines.join("\n")}`,
					"info",
				);
				refreshStatus(ctx);
				return;
			}

			if (sub === "jobs" || sub === "tasks") {
				const jobs = jobManager.list();
				if (jobs.length === 0) {
					ctx.ui.notify("realkb: no PDF import jobs in this session.", "info");
					return;
				}
				const lines = jobs.map((j) => {
					if (j.status === "running") {
						const dur = formatDuration(Date.now() - j.startedAt);
						return `• ${j.id} [running · ${dur}] → KB ${j.kb.id} ("${j.kb.name}"): ${formatJobProgressShort(j)}`;
					}
					return `• ${formatJobOutcomeSummary(j)}`;
				});
				ctx.ui.notify(`realkb import jobs (${jobs.length}):\n${lines.join("\n")}`, "info");
				return;
			}

			if (sub === "stop") {
				const target = rest || "all";
				const stopped = jobManager.stopJob(target);
				if (stopped.length === 0) {
					ctx.ui.notify("realkb: no matching running import jobs to stop.", "info");
				} else {
					ctx.ui.notify(
						`realkb: stopping import job(s): ${stopped.map((j) => j.id).join(", ")}`,
						"info",
					);
				}
				refreshStatus(ctx);
				return;
			}

			if (sub === "config") {
				await handleConfigCommand(rest, ctx);
				return;
			}

			if (sub === "cleanup") {
				const res = await cleanupUnreferencedObjects(rootDir);
				ctx.ui.notify(
					`realkb cleanup: removed ${res.deletedCount} unreferenced PDF(s) (${formatSize(res.deletedBytes)} freed), retained ${res.retainedCount} referenced PDF(s).`,
					"info",
				);
				return;
			}

			ctx.ui.notify(
				"realkb subcommands: list, status, create <name>, connect [id-or-name], disconnect [id-or-name], jobs, stop [id|all], config, cleanup",
				"info",
			);
		},
	});
}
