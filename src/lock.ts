import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

interface LockRecord {
	owner: string;
	pid: number;
	host: string;
	acquired: number;
	expires: number;
}

const inProcessQueues = new Map<string, Promise<void>>();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class LockTimeoutError extends Error {}

/**
 * Serialize async operations both within the current Node process and across concurrent Pi sessions
 * using an atomic lock file under `<rootDir>/tmp/<name>.lock`.
 */
export async function withFileLock<T>(
	rootDir: string,
	name: string,
	fn: () => Promise<T> | T,
	opts?: { ttlMs?: number; waitMs?: number },
): Promise<T> {
	const ttlMs = opts?.ttlMs ?? 120_000;
	const waitMs = opts?.waitMs ?? 60_000;
	const lockDir = join(rootDir, "tmp");
	mkdirSync(lockDir, { recursive: true, mode: 0o700 });
	const lockPath = join(lockDir, `${name}.lock`);

	const prev = inProcessQueues.get(lockPath) ?? Promise.resolve();
	let releaseInProcess!: () => void;
	const gate = new Promise<void>((r) => {
		releaseInProcess = r;
	});
	const chain = prev.then(() => gate);
	inProcessQueues.set(lockPath, chain);

	await prev;
	const owner = `${process.pid}-${randomBytes(6).toString("hex")}`;
	const currentHost = hostname();
	const deadline = Date.now() + waitMs;

	try {
		while (true) {
			const now = Date.now();
			try {
				const fd = openSync(lockPath, "wx", 0o600);
				const rec: LockRecord = {
					owner,
					pid: process.pid,
					host: currentHost,
					acquired: now,
					expires: now + ttlMs,
				};
				writeFileSync(fd, JSON.stringify(rec), "utf8");
				closeSync(fd);
				break;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") throw err;
				try {
					const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
					const expired = typeof raw.expires === "number" && raw.expires <= now;
					const deadLocalProcess =
						raw.host === currentHost && typeof raw.pid === "number" && !isPidAlive(raw.pid);
					if (expired || deadLocalProcess) {
						try {
							unlinkSync(lockPath);
							continue;
						} catch {
							// another process cleaned it up
						}
					}
				} catch {
					// partially written or already removed
				}
				if (Date.now() >= deadline) {
					throw new LockTimeoutError(`Timed out waiting for realkb lock "${name}"`);
				}
				await sleep(40 + Math.floor(Math.random() * 40));
			}
		}

		const heartbeat = setInterval(() => {
			try {
				const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
				if (current.owner === owner) {
					const updated: LockRecord = {
						owner,
						pid: process.pid,
						host: currentHost,
						acquired: current.acquired ?? Date.now(),
						expires: Date.now() + ttlMs,
					};
					writeFileSync(lockPath, JSON.stringify(updated), { mode: 0o600 });
				}
			} catch {
				// ignore
			}
		}, Math.max(1000, Math.floor(ttlMs / 3)));
		heartbeat.unref?.();

		try {
			return await fn();
		} finally {
			clearInterval(heartbeat);
			try {
				const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
				if (current.owner === owner) unlinkSync(lockPath);
			} catch {
				// already cleaned up
			}
		}
	} finally {
		releaseInProcess();
		if (inProcessQueues.get(lockPath) === chain) {
			inProcessQueues.delete(lockPath);
		}
	}
}
