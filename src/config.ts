import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type ApprovalMode = "ask" | "yolo";

export interface EmbeddingConfig {
	/** OpenAI-compatible base URL, with or without a trailing `/v1`. */
	endpoint: string;
	/** API key; `$VAR` or `env:VAR` reads an environment variable. */
	apiKey: string;
	/** Embedding model identifier. */
	model: string;
	/** Vector dimensions (32..8192). */
	dimensions: number;
	/** Optional instruction prefix/field used when embedding search queries. */
	queryInstruction: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs: number;
	/** Max texts per embedding request batch. */
	batchSize: number;
}

export interface RealkbConfig {
	approvalMode: ApprovalMode;
	embedding: EmbeddingConfig;
}

export const DEFAULT_CONFIG: RealkbConfig = {
	approvalMode: "ask",
	embedding: {
		endpoint: "",
		apiKey: "",
		model: "",
		dimensions: 4096,
		queryInstruction: "Instruct: Given a search query, retrieve relevant passages from the knowledge base\nQuery: ",
		timeoutMs: 30_000,
		batchSize: 16,
	},
};

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

/** Resolve the default `~/.pi/agent/realkb` directory (or override via `REALKB_DIR`). */
export function defaultRealkbDir(): string {
	const explicit = process.env.REALKB_DIR?.trim();
	if (explicit) return resolve(explicit);
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (agentDir) return join(resolve(agentDir), "realkb");
	return join(homedir(), ".pi", "agent", "realkb");
}

export function configFilePath(rootDir = defaultRealkbDir()): string {
	return join(rootDir, "config.json");
}

export function normalizeConfig(raw: unknown): RealkbConfig {
	const out: RealkbConfig = structuredClone(DEFAULT_CONFIG);
	if (!raw || typeof raw !== "object") return out;
	const obj = raw as Record<string, unknown>;
	if (obj.approvalMode === "yolo" || obj.approvalMode === "ask") {
		out.approvalMode = obj.approvalMode;
	}
	if (obj.embedding && typeof obj.embedding === "object") {
		const emb = obj.embedding as Record<string, unknown>;
		if (typeof emb.endpoint === "string") out.embedding.endpoint = emb.endpoint.trim();
		if (typeof emb.apiKey === "string") out.embedding.apiKey = emb.apiKey.trim();
		if (typeof emb.model === "string") out.embedding.model = emb.model.trim();
		if (typeof emb.dimensions === "number" && Number.isFinite(emb.dimensions)) {
			out.embedding.dimensions = Math.round(clamp(emb.dimensions, 32, 8192));
		}
		if (typeof emb.queryInstruction === "string") {
			out.embedding.queryInstruction = emb.queryInstruction;
		}
		if (typeof emb.timeoutMs === "number" && Number.isFinite(emb.timeoutMs)) {
			out.embedding.timeoutMs = Math.round(clamp(emb.timeoutMs, 1000, 600_000));
		}
		if (typeof emb.batchSize === "number" && Number.isFinite(emb.batchSize)) {
			out.embedding.batchSize = Math.round(clamp(emb.batchSize, 1, 512));
		}
	}
	if (/^\s*(none|off|-)?\s*$/i.test(out.embedding.endpoint)) {
		out.embedding.endpoint = "";
	}
	return out;
}

export function loadConfig(rootDir = defaultRealkbDir()): RealkbConfig {
	const file = configFilePath(rootDir);
	if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return normalizeConfig(raw);
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: RealkbConfig, rootDir = defaultRealkbDir()): void {
	const file = configFilePath(rootDir);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	let existing: Record<string, unknown> = {};
	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			// overwrite invalid JSON
		}
	}
	const normalized = normalizeConfig(config);
	const merged = {
		...existing,
		approvalMode: normalized.approvalMode,
		embedding: normalized.embedding,
	};
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
	try {
		chmodSync(file, 0o600);
	} catch {
		// best effort
	}
}

export function configMtime(rootDir = defaultRealkbDir()): number {
	try {
		return statSync(configFilePath(rootDir)).mtimeMs;
	} catch {
		return 0;
	}
}

/** Resolve `$VAR`, `${VAR}`, or `env:VAR` references at runtime without storing resolved secrets on disk. */
export function resolveSecret(value: string): string {
	const v = value.trim();
	const m = /^(?:\$\{?|env:)([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v);
	if (m) return process.env[m[1]] ?? "";
	return v;
}

/** Normalize an OpenAI-compatible base URL: trim whitespace/trailing slashes and remove a trailing `/v1`. */
export function normalizeEndpoint(url: string): string {
	return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Identity of the configured embedding space. Changing it marks old vectors as incompatible. */
export function embeddingFingerprint(cfg: RealkbConfig): string {
	return `${normalizeEndpoint(cfg.embedding.endpoint)}|${cfg.embedding.model.trim().toLowerCase()}|${cfg.embedding.dimensions}`;
}

/** Safe display string for an API key; never reveals the secret value. */
export function maskSecret(value: string): string {
	const v = value.trim();
	if (!v) return "(not set)";
	if (/^(?:\$\{?|env:)[A-Za-z_]/.test(v)) return v;
	return "(configured)";
}
