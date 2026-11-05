export const REALKB_SESSION_ENTRY_TYPE = "realkb-state";

export type ApprovalCategory = "connect" | "import";

export interface SessionApprovalOverrides {
	connect?: boolean;
	import?: boolean;
}

export interface RealkbSessionEntryData {
	v: 1;
	sessionId: string;
	connectedKbs: string[];
	approvalOverrides: SessionApprovalOverrides;
}

export interface BranchEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export class SessionStateManager {
	private currentSessionId = "";
	private connectedKbs = new Set<string>();
	private approvalOverrides: SessionApprovalOverrides = {};

	get sessionId(): string {
		return this.currentSessionId;
	}

	getConnectedKbs(): string[] {
		return [...this.connectedKbs].sort();
	}

	isConnected(kbId: string): boolean {
		return this.connectedKbs.has(kbId);
	}

	getApprovalOverrides(): SessionApprovalOverrides {
		return { ...this.approvalOverrides };
	}

	hasSessionApprovalOverride(category: ApprovalCategory): boolean {
		return this.approvalOverrides[category] === true;
	}

	/**
	 * Reconstruct state from the active conversation branch (`ctx.sessionManager.getBranch()`)
	 * according to the approved lifecycle table:
	 * - New session: no connected KBs, no overrides
	 * - Resume saved session: restore that session's connections and overrides
	 * - Fork into a new session: inherit connections at the fork point, reset overrides to global settings
	 * - Rewind within a session: restore connections and overrides at the selected point
	 * - Reload the plugin: keep connections and overrides unchanged
	 */
	restoreFromBranch(params: {
		sessionId: string;
		reason: "startup" | "reload" | "new" | "resume" | "fork" | "tree";
		branchEntries: BranchEntryLike[];
	}): { shouldPersistForkReset: boolean } {
		const { sessionId, reason, branchEntries } = params;
		this.currentSessionId = sessionId;

		if (reason === "new") {
			this.connectedKbs = new Set();
			this.approvalOverrides = {};
			return { shouldPersistForkReset: false };
		}

		let latestEntry: RealkbSessionEntryData | undefined;
		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === REALKB_SESSION_ENTRY_TYPE) {
				const raw = entry.data as Partial<RealkbSessionEntryData> | undefined;
				if (raw && raw.v === 1 && Array.isArray(raw.connectedKbs)) {
					latestEntry = {
						v: 1,
						sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
						connectedKbs: raw.connectedKbs.filter((x): x is string => typeof x === "string"),
						approvalOverrides:
							raw.approvalOverrides && typeof raw.approvalOverrides === "object"
								? {
										connect: Boolean(raw.approvalOverrides.connect),
										import: Boolean(raw.approvalOverrides.import),
									}
								: {},
					};
				}
			}
		}

		if (!latestEntry) {
			this.connectedKbs = new Set();
			this.approvalOverrides = {};
			return { shouldPersistForkReset: false };
		}

		this.connectedKbs = new Set(latestEntry.connectedKbs);

		const isFromSameSession =
			Boolean(sessionId) && latestEntry.sessionId === sessionId;
		if (reason === "fork" || !isFromSameSession) {
			// Inherit connected KBs at the fork point, but reset session approval overrides to global settings.
			this.approvalOverrides = {};
			const hadOverrides = Boolean(
				latestEntry.approvalOverrides.connect || latestEntry.approvalOverrides.import,
			);
			return { shouldPersistForkReset: reason === "fork" || hadOverrides };
		}

		this.approvalOverrides = {
			...(latestEntry.approvalOverrides.connect ? { connect: true } : {}),
			...(latestEntry.approvalOverrides.import ? { import: true } : {}),
		};
		return { shouldPersistForkReset: false };
	}

	connect(kbIds: string[]): boolean {
		let changed = false;
		for (const id of kbIds) {
			if (!this.connectedKbs.has(id)) {
				this.connectedKbs.add(id);
				changed = true;
			}
		}
		return changed;
	}

	disconnect(kbIds: string[]): boolean {
		let changed = false;
		for (const id of kbIds) {
			if (this.connectedKbs.delete(id)) {
				changed = true;
			}
		}
		return changed;
	}

	setSessionApprovalOverride(category: ApprovalCategory, enabled: boolean): boolean {
		const prev = Boolean(this.approvalOverrides[category]);
		if (prev === enabled) return false;
		if (enabled) {
			this.approvalOverrides[category] = true;
		} else {
			delete this.approvalOverrides[category];
		}
		return true;
	}

	resetSessionApprovalOverrides(): boolean {
		const hadAny = Boolean(this.approvalOverrides.connect || this.approvalOverrides.import);
		this.approvalOverrides = {};
		return hadAny;
	}

	toEntryData(): RealkbSessionEntryData {
		return {
			v: 1,
			sessionId: this.currentSessionId,
			connectedKbs: this.getConnectedKbs(),
			approvalOverrides: this.getApprovalOverrides(),
		};
	}
}
