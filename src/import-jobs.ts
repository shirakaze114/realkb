import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { RealkbConfig } from "./config.ts";
import {
	type BatchImportResult,
	type ImportProgressEvent,
	type ImportStage,
	importPdfsToKb,
} from "./engine.ts";
import { formatCitation, type KbMeta } from "./storage.ts";

export const REALKB_NOTIFICATION_TYPE = "realkb-notification";
export const REALKB_DOCK_WIDGET = "realkb-dock";

const STAR = ["·", "✢", "✱", "✶", "✻", "✽"];
export const SPINNER = [...STAR, ...STAR.slice(1, -1).toReversed()];
export const FRAME_MS = 120;
export const LINGER_MS = 10_000;
const DOCK_MAX_ROWS = 4;

export function spinnerFrame(now = Date.now()): string {
	return SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length];
}

export function formatDuration(ms: number): string {
	const safeMs = Math.max(0, Math.round(ms));
	if (safeMs < 1000) return `${safeMs}ms`;
	const totalSec = Math.floor(safeMs / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const mins = Math.floor(totalSec / 60);
	const secs = totalSec % 60;
	if (mins < 60) return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
}

export function formatImportBatchSummary(_rootDir: string, kb: KbMeta, batch: BatchImportResult): string {
	const lines: string[] = [
		`Import summary for KB ${kb.id} ("${kb.name}"):`,
		`- Ready: ${batch.ready.length} | Already imported: ${batch.alreadyImported.length} | Failed/Unfinished: ${batch.failed.length}`,
	];

	if (batch.ready.length > 0) {
		lines.push("", "Ready sources:");
		for (const item of batch.ready) {
			const cit =
				item.citation ??
				(item.shortHash ? formatCitation(kb.id, item.shortHash) : "");
			const unreadableNote =
				item.unreadablePages && item.unreadablePages.length > 0
					? ` ⚠ Incomplete text coverage: ${item.unreadablePages.length} scanned/unreadable page(s) (p.${item.unreadablePages.slice(0, 10).join(", p.")}${item.unreadablePages.length > 10 ? "…" : ""})`
					: "";
			const figNote = item.figureCount ? `, ${item.figureCount} figure marker(s)` : "";
			lines.push(
				`- ${cit} "${item.filename}" — ${item.usableTextPages}/${item.pageCount} usable page(s), ${item.chunkCount} chunk(s)${figNote}${unreadableNote}`,
			);
		}
	}

	if (batch.alreadyImported.length > 0) {
		lines.push("", "Already imported (skipped duplicate):");
		for (const item of batch.alreadyImported) {
			const cit =
				item.citation ??
				(item.shortHash ? formatCitation(kb.id, item.shortHash) : "");
			lines.push(
				`- ${cit} "${item.filename}" — ${item.usableTextPages}/${item.pageCount} usable page(s), ${item.chunkCount ?? 0} chunk(s)`,
			);
		}
	}

	if (batch.failed.length > 0) {
		lines.push("", "Failed / unfinished sources (not marked ready; re-run import to retry):");
		for (const item of batch.failed) {
			const cit = item.citation ? `${item.citation} ` : "";
			const reuseNote = item.reusedExtraction ? " (reused saved extraction)" : "";
			lines.push(
				`- ${cit}"${item.filename}" [failed at ${item.failingStep ?? "unknown"}${reuseNote}]: ${item.reason}`,
			);
		}
	}

	return lines.join("\n");
}

export type ImportJobStatus = "running" | "completed" | "failed" | "stopped";

export interface ImportJob {
	id: string;
	kb: KbMeta;
	paths: string[];
	cwd: string;
	rootDir: string;
	totalFiles: number;
	status: ImportJobStatus;
	startedAt: number;
	endedAt?: number;
	background: boolean;
	notified: boolean;
	progress?: ImportProgressEvent;
	result?: BatchImportResult;
	error?: string;
	readonly abortController: AbortController;
	promise?: Promise<BatchImportResult>;
}

export interface ImportNotificationItem {
	id: string;
	kbId: string;
	kbName: string;
	status: ImportJobStatus;
	summary: string;
	level: "info" | "warning" | "error";
}

export interface ImportNotificationDetails {
	items: ImportNotificationItem[];
}

function stageLabel(stage: ImportStage): string {
	switch (stage) {
		case "queued":
			return "queued";
		case "extracting":
			return "extracting";
		case "chunking":
			return "chunking";
		case "embedding":
			return "embedding";
		case "indexing":
			return "indexing";
		case "file_done":
			return "processed";
		case "completed":
		default:
			return "completed";
	}
}

export function formatJobProgressShort(job: ImportJob): string {
	const p = job.progress;
	if (!p) {
		return `0/${job.totalFiles} files · starting…`;
	}
	if (p.stage === "embedding" && p.totalChunks && p.totalChunks > 0) {
		const done = p.embeddedChunks ?? 0;
		const pct = Math.round((done / p.totalChunks) * 100);
		return `[${p.fileIndex}/${p.totalFiles}] ${p.filename} · embedding ${done}/${p.totalChunks} chunks (${pct}%)`;
	}
	if (p.filename) {
		return `[${p.fileIndex}/${p.totalFiles}] ${p.filename} · ${stageLabel(p.stage)}`;
	}
	return p.message;
}

export function formatJobOutcomeSummary(job: ImportJob, now = Date.now()): string {
	const dur = formatDuration((job.endedAt ?? now) - job.startedAt);
	if (job.result) {
		const { ready, alreadyImported, failed } = job.result;
		return `${job.id} ${job.status} (${dur}) · KB ${job.kb.id} ("${job.kb.name}"): ${ready.length} ready, ${alreadyImported.length} skipped, ${failed.length} failed`;
	}
	if (job.status === "stopped") {
		return `${job.id} stopped (${dur}) · KB ${job.kb.id} ("${job.kb.name}")`;
	}
	return `${job.id} ${job.status} (${dur}) · KB ${job.kb.id} ("${job.kb.name}"): ${job.error ?? "failed"}`;
}

export function formatTerminalNotificationBlock(job: ImportJob, now = Date.now()): string {
	const dur = formatDuration((job.endedAt ?? now) - job.startedAt);
	const attrs = [`id="${job.id}"`, `kb="${job.kb.id}"`, `status="${job.status}"`, `duration="${dur}"`];
	const body = job.result
		? formatImportBatchSummary(job.rootDir, job.kb, job.result)
		: `Import job ${job.id} into KB ${job.kb.id} ("${job.kb.name}") ${job.status}: ${job.error ?? "stopped"}`;
	return `<realkb-notification ${attrs.join(" ")}>\n${body}\n</realkb-notification>`;
}

function jobLevel(job: ImportJob): "info" | "warning" | "error" {
	if (job.status === "failed") return "error";
	if (job.status === "stopped") return "warning";
	if (job.result && job.result.failed.length > 0) return "warning";
	return "info";
}

export class ImportJobManager {
	private nextSeq = 1;
	private jobs = new Map<string, ImportJob>();
	private listeners = new Set<() => void>();
	private pendingWake: ImportJob[] = [];
	private readonly pi: ExtensionAPI;
	ctx: ExtensionContext | undefined;
	busy = false;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	emitChange(): void {
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {
				// ignore stale listener
			}
		}
	}

	list(): ImportJob[] {
		return [...this.jobs.values()];
	}

	get(id: string): ImportJob | undefined {
		return this.jobs.get(id);
	}

	runningJobs(): ImportJob[] {
		return this.list().filter((j) => j.status === "running");
	}

	startJob(params: {
		kb: KbMeta;
		paths: string[];
		allowExt?: string[];
		validFileCount: number;
		cwd: string;
		rootDir: string;
		config: RealkbConfig;
		background: boolean;
	}): ImportJob {
		const id = `imp-${this.nextSeq++}`;
		const abortController = new AbortController();
		const job: ImportJob = {
			id,
			kb: params.kb,
			paths: params.paths,
			cwd: params.cwd,
			rootDir: params.rootDir,
			totalFiles: params.validFileCount,
			status: "running",
			startedAt: Date.now(),
			background: params.background,
			notified: false,
			abortController,
		};

		job.promise = importPdfsToKb({
			kbIdOrName: params.kb.id,
			paths: params.paths,
			allowExt: params.allowExt,
			cwd: params.cwd,
			rootDir: params.rootDir,
			config: params.config,
			signal: abortController.signal,
			onProgress: (ev) => {
				job.progress = ev;
				this.emitChange();
			},
		})
			.then((batch) => {
				job.result = batch;
				job.endedAt = Date.now();
				job.status = abortController.signal.aborted ? "stopped" : "completed";
				this.emitChange();
				if (job.background) {
					this.notifyCompletion(job);
				}
				return batch;
			})
			.catch((err) => {
				job.endedAt = Date.now();
				job.error = err instanceof Error ? err.message : String(err);
				job.status = abortController.signal.aborted ? "stopped" : "failed";
				this.emitChange();
				if (job.background) {
					this.notifyCompletion(job);
				}
				throw err;
			});

		this.jobs.set(id, job);
		this.emitChange();
		return job;
	}

	promoteToBackground(job: ImportJob): void {
		if (job.background) return;
		job.background = true;
		this.emitChange();
		if (job.status !== "running" && !job.notified) {
			this.notifyCompletion(job);
		}
	}

	stopJob(idOrAll: string): ImportJob[] {
		const targets =
			idOrAll === "all"
				? this.runningJobs()
				: (() => {
						const j = this.jobs.get(idOrAll);
						return j && j.status === "running" ? [j] : [];
					})();
		for (const j of targets) {
			j.abortController.abort(new Error("Stopped by user"));
		}
		return targets;
	}

	private notifyCompletion(job: ImportJob): void {
		if (job.notified) return;
		const mode = this.ctx?.mode ?? "print";
		const headless = mode === "print" || mode === "json";
		if (headless) {
			if (!this.pendingWake.includes(job)) {
				this.pendingWake.push(job);
			}
			return;
		}

		const item: ImportNotificationItem = {
			id: job.id,
			kbId: job.kb.id,
			kbName: job.kb.name,
			status: job.status,
			summary: formatJobOutcomeSummary(job),
			level: jobLevel(job),
		};
		const content = formatTerminalNotificationBlock(job);
		const details: ImportNotificationDetails = { items: [item] };

		try {
			this.pi.sendMessage(
				{
					customType: REALKB_NOTIFICATION_TYPE,
					content,
					display: true,
					details,
				},
				this.busy ? { deliverAs: "steer" } : { triggerTurn: true },
			);
			job.notified = true;
			if (this.ctx?.hasUI) {
				this.ctx.ui.notify(item.summary, item.level);
			}
		} catch {
			if (!this.pendingWake.includes(job)) {
				this.pendingWake.push(job);
			}
		}
	}

	hasHeldWake(): boolean {
		return this.pendingWake.some((j) => !j.notified);
	}

	takeForSettle(): { content: string; details: ImportNotificationDetails } | undefined {
		const unnotified = this.pendingWake.filter((j) => !j.notified);
		this.pendingWake = [];
		if (unnotified.length === 0) return undefined;
		const items: ImportNotificationItem[] = [];
		const blocks: string[] = [];
		for (const job of unnotified) {
			job.notified = true;
			items.push({
				id: job.id,
				kbId: job.kb.id,
				kbName: job.kb.name,
				status: job.status,
				summary: formatJobOutcomeSummary(job),
				level: jobLevel(job),
			});
			blocks.push(formatTerminalNotificationBlock(job));
		}
		return {
			content: blocks.join("\n\n"),
			details: { items },
		};
	}
}

export function visibleDockJobs(jobs: ImportJob[], now = Date.now()): ImportJob[] {
	return jobs.filter((j) => j.status === "running" || (j.endedAt ?? 0) > now - LINGER_MS);
}

function statusIcon(job: ImportJob, th: Theme, now = Date.now()): string {
	switch (job.status) {
		case "running":
			return th.fg("accent", spinnerFrame(now));
		case "completed":
			return th.fg("success", "✓");
		case "stopped":
			return th.fg("warning", "■");
		case "failed":
		default:
			return th.fg("error", "✗");
	}
}

function dockJobRow(job: ImportJob, th: Theme, now: number): string {
	const icon = statusIcon(job, th, now);
	const idStr = th.fg("dim", job.id);
	const kbStr = th.fg(job.status === "running" ? "text" : "muted", `KB ${job.kb.id} ("${job.kb.name}")`);
	const dur = formatDuration((job.endedAt ?? now) - job.startedAt);
	if (job.status === "running") {
		const prog = formatJobProgressShort(job);
		return `${icon} ${idStr} → ${kbStr} · ${th.fg("dim", `${prog} · ${dur}`)}`;
	}
	if (job.result) {
		const { ready, alreadyImported, failed } = job.result;
		return `${icon} ${idStr} → ${kbStr} · ${th.fg("dim", `${ready.length} ready, ${alreadyImported.length} skipped, ${failed.length} failed · ${dur}`)}`;
	}
	return `${icon} ${idStr} → ${kbStr} · ${th.fg("dim", `${job.status} · ${dur}`)}`;
}

export function dockLines(jobs: ImportJob[], th: Theme, width: number, now = Date.now()): string[] {
	const shown = visibleDockJobs(jobs, now);
	if (shown.length === 0) return [];
	const running = shown.filter((j) => j.status === "running").length;
	const done = shown.length - running;
	const fit = (s: string) => truncateToWidth(s, width, "…");
	const color = running ? "accent" : "dim";
	const counts = [running ? `${running} running` : "", done ? `${done} done` : ""].filter(Boolean).join(" · ");
	const lines = [fit(`${th.fg(color, running ? "●" : "○")} ${th.fg(color, `KB Imports (${counts})`)}`)];

	const ordered = [
		...shown.filter((j) => j.status === "running"),
		...shown.filter((j) => j.status !== "running").toReversed(),
	];
	const visible = ordered.slice(0, DOCK_MAX_ROWS);
	const hidden = ordered.length - visible.length;
	visible.forEach((j, i) => {
		const last = i === visible.length - 1 && hidden === 0;
		lines.push(fit(`${th.fg("dim", last ? "└─" : "├─")} ${dockJobRow(j, th, now)}`));
	});
	if (hidden > 0) {
		lines.push(fit(`${th.fg("dim", "└─")} ${th.fg("dim", `+${hidden} more · /realkb jobs`)}`));
	}
	lines.push("");
	return lines;
}

class RealkbDockComponent implements Component {
	private readonly mgr: ImportJobManager;
	private readonly th: Theme;
	private readonly tui: TUI;
	private readonly off: () => void;
	private readonly ticker: ReturnType<typeof setInterval>;

	constructor(mgr: ImportJobManager, tui: TUI, th: Theme) {
		this.mgr = mgr;
		this.tui = tui;
		this.th = th;
		this.off = mgr.onChange(() => this.tui.requestRender());
		this.ticker = setInterval(() => this.tui.requestRender(), FRAME_MS);
		this.ticker.unref();
	}

	render(width: number): string[] {
		return dockLines(this.mgr.list(), this.th, width);
	}

	invalidate(): void {}

	dispose(): void {
		this.off();
		clearInterval(this.ticker);
	}
}

export function installRealkbDock(
	mgr: ImportJobManager,
	ctx: ExtensionContext,
	onRefreshStatus: () => void,
): () => void {
	if (!ctx.hasUI || ctx.mode !== "tui") return () => {};
	let shown = false;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let lingerTimer: ReturnType<typeof setTimeout> | undefined;

	const sync = () => {
		const jobs = mgr.list();
		const visible = visibleDockJobs(jobs).length > 0;
		if (visible && !shown) {
			ctx.ui.setWidget(REALKB_DOCK_WIDGET, (tui, th) => new RealkbDockComponent(mgr, tui, th));
			shown = true;
		} else if (!visible && shown) {
			ctx.ui.setWidget(REALKB_DOCK_WIDGET, undefined);
			shown = false;
		}

		const anyRunning = jobs.some((j) => j.status === "running");
		if (anyRunning && !statusTimer) {
			statusTimer = setInterval(onRefreshStatus, FRAME_MS);
			statusTimer.unref();
		} else if (!anyRunning && statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}

		if (lingerTimer) clearTimeout(lingerTimer);
		lingerTimer = undefined;
		if (visible && !anyRunning) {
			lingerTimer = setTimeout(sync, LINGER_MS + 50);
			lingerTimer.unref();
		}
		onRefreshStatus();
	};

	const off = mgr.onChange(sync);
	sync();
	return () => {
		off();
		if (statusTimer) clearInterval(statusTimer);
		if (lingerTimer) clearTimeout(lingerTimer);
		try {
			ctx.ui.setWidget(REALKB_DOCK_WIDGET, undefined);
		} catch {
			// ignore stale UI context
		}
	};
}

export function renderImportNotification(
	details: ImportNotificationDetails | undefined,
	content: string,
	expanded: boolean,
	th: Theme,
): Component {
	const items = details?.items ?? [];
	if (expanded || items.length === 0) {
		return new Text(th.fg("dim", content), 1, 0);
	}
	const lines = items.map((item) => {
		const color = item.level === "error" || item.level === "warning" ? item.level : "success";
		let mark = "✓";
		if (item.level === "error") mark = "✗";
		else if (item.level === "warning") mark = "!";
		return `${th.fg(color, mark)} ${th.fg("dim", "realkb")} ${item.summary}`;
	});
	return new Text(lines.join("\n"), 1, 0);
}
