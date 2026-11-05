import { createHash } from "node:crypto";
import {
	embeddingFingerprint,
	normalizeEndpoint,
	type RealkbConfig,
	resolveSecret,
} from "./config.ts";

export class EmbeddingApiError extends Error {
	readonly status: number | undefined;
	readonly isInputLengthError: boolean;

	constructor(message: string, opts?: { status?: number; isInputLengthError?: boolean }) {
		super(message);
		this.name = "EmbeddingApiError";
		this.status = opts?.status;
		this.isInputLengthError = opts?.isInputLengthError ?? false;
	}
}

interface OpenAiEmbeddingItem {
	index: number;
	embedding: number[] | string;
}

interface OpenAiEmbeddingResponse {
	data?: OpenAiEmbeddingItem[];
	usage?: {
		prompt_tokens?: number;
		total_tokens?: number;
	};
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("aborted"));
			},
			{ once: true },
		);
	});

function extractErrorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as {
			error?: { message?: string; type?: string; code?: string } | string;
			message?: string;
			detail?: string;
		};
		if (typeof parsed?.error === "string") return parsed.error.slice(0, 300);
		if (parsed?.error && typeof parsed.error === "object") {
			return [parsed.error.type, parsed.error.code, parsed.error.message]
				.filter(Boolean)
				.join(": ")
				.slice(0, 300);
		}
		if (typeof parsed?.message === "string") return parsed.message.slice(0, 300);
		if (typeof parsed?.detail === "string") return parsed.detail.slice(0, 300);
	} catch {
		// non-JSON response
	}
	return body.slice(0, 300);
}

function looksLikeInputLengthError(status: number, bodyText: string): boolean {
	if (status === 413) return true;
	if (status !== 400 && status !== 422) return false;
	return /(?:context[_\s-]*length|max[_\s-]*tokens|too\s+long|maximum\s+input|input\s+length|token\s+limit)/i.test(
		bodyText,
	);
}

export function decodeEmbeddingVector(raw: number[] | string, expectedDimensions?: number): Float32Array {
	let out: Float32Array;
	if (typeof raw === "string") {
		const buf = Buffer.from(raw, "base64");
		if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) {
			throw new EmbeddingApiError(`Invalid base64 embedding byte length (${buf.byteLength})`);
		}
		out = new Float32Array(buf.byteLength / 4);
		for (let i = 0; i < out.length; i++) {
			out[i] = buf.readFloatLE(i * 4);
		}
	} else if (Array.isArray(raw)) {
		out = Float32Array.from(raw);
	} else {
		throw new EmbeddingApiError("Invalid embedding payload format");
	}

	if (expectedDimensions !== undefined && out.length !== expectedDimensions) {
		throw new EmbeddingApiError(
			`Embedding dimension mismatch: expected ${expectedDimensions}, received ${out.length}`,
		);
	}

	let normSq = 0;
	for (let i = 0; i < out.length; i++) {
		const v = out[i];
		if (!Number.isFinite(v)) {
			throw new EmbeddingApiError("Embedding vector contains non-finite values");
		}
		normSq += v * v;
	}
	if (normSq === 0) {
		throw new EmbeddingApiError("Embedding vector is all zeros");
	}
	const norm = Math.sqrt(normSq);
	if (Math.abs(norm - 1) > 1e-4) {
		for (let i = 0; i < out.length; i++) {
			out[i] /= norm;
		}
	}
	return out;
}

function splitTextNearMidpoint(text: string): [string, string] | undefined {
	const trimmed = text.trim();
	if (trimmed.length < 16) return undefined;
	const mid = Math.floor(trimmed.length / 2);
	let splitIdx = -1;
	for (let offset = 0; offset < Math.floor(trimmed.length / 3); offset++) {
		const right = mid + offset;
		const left = mid - offset;
		if (right < trimmed.length && /\s/.test(trimmed[right])) {
			splitIdx = right;
			break;
		}
		if (left > 0 && /\s/.test(trimmed[left])) {
			splitIdx = left;
			break;
		}
	}
	if (splitIdx <= 0 || splitIdx >= trimmed.length) {
		splitIdx = mid;
	}
	const a = trimmed.slice(0, splitIdx).trim();
	const b = trimmed.slice(splitIdx).trim();
	if (!a || !b) return undefined;
	return [a, b];
}

function averageVectors(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(a.length);
	let normSq = 0;
	for (let i = 0; i < a.length; i++) {
		const v = (a[i] + b[i]) * 0.5;
		out[i] = v;
		normSq += v * v;
	}
	const norm = Math.sqrt(normSq);
	if (norm > 0) {
		for (let i = 0; i < out.length; i++) out[i] /= norm;
	}
	return out;
}

export class Embedder {
	private readonly config: RealkbConfig;

	constructor(config: RealkbConfig) {
		this.config = config;
	}

	get configured(): boolean {
		return Boolean(normalizeEndpoint(this.config.embedding.endpoint) && this.config.embedding.model.trim());
	}

	get fingerprint(): string {
		return embeddingFingerprint(this.config);
	}

	get dimensions(): number {
		return this.config.embedding.dimensions;
	}

	private get embeddingsUrl(): string {
		return `${normalizeEndpoint(this.config.embedding.endpoint)}/v1/embeddings`;
	}

	private async postBatch(
		inputs: string[],
		kind: "document" | "query",
		signal?: AbortSignal,
	): Promise<Float32Array[]> {
		const cfg = this.config.embedding;
		if (!this.configured) {
			throw new EmbeddingApiError(
				"Embedding API is not configured. Check ~/.pi/agent/realkb/config.json or run /realkb config.",
			);
		}
		const apiKey = resolveSecret(cfg.apiKey);
		const url = this.embeddingsUrl;
		const sanitizedInputs = inputs.map((t) => {
			const trimmed = t.trim();
			if (!trimmed) return "(empty)";
			if (kind === "query" && cfg.queryInstruction.trim()) {
				return `${cfg.queryInstruction}${trimmed}`;
			}
			return trimmed;
		});

		const body: Record<string, unknown> = {
			model: cfg.model.trim(),
			input: sanitizedInputs,
			dimensions: cfg.dimensions,
			encoding_format: "base64",
		};

		const maxRetries = 2;
		for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
			if (signal?.aborted) throw new EmbeddingApiError("Embedding request aborted");
			const headers: Record<string, string> = {
				"content-type": "application/json",
				accept: "application/json",
			};
			if (apiKey) {
				headers.authorization = `Bearer ${apiKey}`;
			}

			let res: Response;
			try {
				res = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: combineSignals(cfg.timeoutMs, signal),
				});
			} catch (err) {
				if (signal?.aborted) throw new EmbeddingApiError("Embedding request aborted");
				const isTimeout =
					err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
				if (isTimeout || attempt > maxRetries) {
					throw new EmbeddingApiError(
						`Embedding request ${isTimeout ? "timed out" : "failed"} (${err instanceof Error ? err.message : String(err)})`,
					);
				}
				await sleep(300 * attempt, signal);
				continue;
			}

			const text = await res.text();
			if (res.ok) {
				let parsed: OpenAiEmbeddingResponse;
				try {
					parsed = JSON.parse(text) as OpenAiEmbeddingResponse;
				} catch {
					throw new EmbeddingApiError(`Invalid JSON response from embedding endpoint (HTTP ${res.status})`, {
						status: res.status,
					});
				}
				if (!Array.isArray(parsed.data) || parsed.data.length !== sanitizedInputs.length) {
					throw new EmbeddingApiError(
						`Embedding response returned ${parsed.data?.length ?? 0} vectors for ${sanitizedInputs.length} inputs`,
						{ status: res.status },
					);
				}
				const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
				return sorted.map((item) => decodeEmbeddingVector(item.embedding, cfg.dimensions));
			}

			if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 529) && attempt <= maxRetries) {
				const retryAfter = Number(res.headers.get("retry-after"));
				const waitMs =
					Number.isFinite(retryAfter) && retryAfter > 0
						? Math.min(10_000, retryAfter * 1000)
						: 400 * attempt;
				await sleep(waitMs, signal);
				continue;
			}

			const isLenErr = looksLikeInputLengthError(res.status, text);
			throw new EmbeddingApiError(
				`Embedding API HTTP ${res.status}: ${extractErrorMessage(text)}`,
				{ status: res.status, isInputLengthError: isLenErr },
			);
		}

		throw new EmbeddingApiError("Embedding request failed after retries");
	}

	private async embedSingleWithSplitFallback(
		text: string,
		kind: "document" | "query",
		depth: number,
		signal?: AbortSignal,
	): Promise<Float32Array> {
		try {
			const [vec] = await this.postBatch([text], kind, signal);
			return vec;
		} catch (err) {
			if (err instanceof EmbeddingApiError && err.isInputLengthError && depth < 2) {
				const halves = splitTextNearMidpoint(text);
				if (halves) {
					const leftVec = await this.embedSingleWithSplitFallback(halves[0], kind, depth + 1, signal);
					const rightVec = await this.embedSingleWithSplitFallback(halves[1], kind, depth + 1, signal);
					return averageVectors(leftVec, rightVec);
				}
			}
			throw err;
		}
	}

	/**
	 * Embed one or more texts in batches of `config.embedding.batchSize`.
	 * Automatically falls back to per-item bounded split-and-retry if a batch hits an input-length error.
	 */
	async embedTexts(
		texts: string[],
		kind: "document" | "query",
		signal?: AbortSignal,
		onBatch?: (
			batchVectors: Float32Array[],
			batchStartIndex: number,
			completedCount: number,
			totalCount: number,
		) => void,
	): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		const batchSize = Math.max(1, this.config.embedding.batchSize);
		const out: Float32Array[] = [];

		for (let i = 0; i < texts.length; i += batchSize) {
			const batch = texts.slice(i, i + batchSize);
			try {
				const vectors = await this.postBatch(batch, kind, signal);
				out.push(...vectors);
				onBatch?.(vectors, i, out.length, texts.length);
			} catch (err) {
				if (err instanceof EmbeddingApiError && err.isInputLengthError) {
					for (let k = 0; k < batch.length; k++) {
						const vec = await this.embedSingleWithSplitFallback(batch[k], kind, 0, signal);
						out.push(vec);
						onBatch?.([vec], i + k, out.length, texts.length);
					}
				} else {
					throw err;
				}
			}
		}

		return out;
	}
}
