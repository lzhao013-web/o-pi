import type { TelemetryRecord } from "./types.js";

export interface SessionTelemetrySnapshot {
	sessionId: string;
	records: readonly unknown[];
	revision: number;
	invalidLines: number;
}

/** Session-scoped immutable event ledger. Historical raw records remain decoder-owned. */
export class SessionTelemetryStore {
	readonly #sessionId: string;
	readonly #records: unknown[] = [];
	readonly #eventIds = new Set<string>();
	#revision = 0;
	readonly #invalidLines: number;

	constructor(sessionId: string, historicalRecords: readonly unknown[] = [], invalidLines = 0) {
		this.#sessionId = sessionId;
		this.#invalidLines = invalidLines;
		for (const record of historicalRecords) {
			const recordSessionId = sessionIdOf(record);
			if (recordSessionId === undefined || recordSessionId === sessionId) this.add(record);
		}
	}

	append(record: TelemetryRecord): void {
		if (record.session_id !== this.#sessionId) return;
		this.add(record);
	}

	snapshot(): SessionTelemetrySnapshot {
		return {
			sessionId: this.#sessionId,
			records: [...this.#records],
			revision: this.#revision,
			invalidLines: this.#invalidLines,
		};
	}

	private add(record: unknown): void {
		const id = eventId(record);
		if (id !== undefined && this.#eventIds.has(id)) return;
		if (id !== undefined) this.#eventIds.add(id);
		this.#records.push(record);
		this.#revision += 1;
	}
}

function eventId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const id = Reflect.get(value, "id");
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function sessionIdOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const sessionId = Reflect.get(value, "session_id");
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}
