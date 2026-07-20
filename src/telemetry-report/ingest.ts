import { readTelemetryRecord } from "./reader.js";
import type { CanonicalDataset, CanonicalTurn, DecodeContext, IngestDiagnostics } from "./model.js";

export interface IngestTelemetryOptions {
	defaultCwd?: string;
}

export function ingestTelemetryRecords(records: readonly unknown[], options: IngestTelemetryOptions = {}): CanonicalDataset {
	const calls: CanonicalDataset["calls"] = [];
	const turns: CanonicalTurn[] = [];
	const sessionIds = new Set<string>();
	const cwdBySession = new Map<string, string>();
	const orderBySession = new Map<string, number>();
	const turnsById = new Map<string, CanonicalTurn>();
	const eventIds = new Set<string>();
	const defaultCwd = options.defaultCwd ?? process.cwd();
	const diagnostics: IngestDiagnostics = {
		decoded_records: 0,
		partial_records: 0,
		unknown_events: 0,
		invalid_records: 0,
		duplicate_records: 0,
	};

	for (const value of records) {
		const sessionId = isRecord(value) ? string(value["session_id"]) : undefined;
		const context: DecodeContext = { cwd: sessionId === undefined ? defaultCwd : cwdBySession.get(sessionId) ?? defaultCwd };
		const result = readTelemetryRecord(value, context);
		if (result.status === "invalid") {
			diagnostics.invalid_records += 1;
			continue;
		}
		const eventId = isRecord(value) ? string(value["id"]) : undefined;
		if (eventId !== undefined && eventIds.has(eventId)) {
			diagnostics.duplicate_records += 1;
			continue;
		}
		if (eventId !== undefined) eventIds.add(eventId);
		if (sessionId !== undefined) sessionIds.add(sessionId);
		if (result.status === "unknown_event") {
			diagnostics.unknown_events += 1;
			continue;
		}
		diagnostics.decoded_records += 1;
		if (result.status === "partial") diagnostics.partial_records += 1;
		if (sessionId === undefined) continue;

		switch (result.record.event) {
			case "session_start":
				cwdBySession.set(sessionId, result.record.cwd);
				break;
			case "turn_start": {
				const turn: CanonicalTurn = {
					id: result.record.turn_id,
					sessionId,
					activeTools: result.record.active_tools,
					definitions: result.record.definitions,
				};
				turns.push(turn);
				turnsById.set(turnKey(sessionId, turn.id), turn);
				break;
			}
			case "tool_call": {
				const order = orderBySession.get(sessionId) ?? 0;
				orderBySession.set(sessionId, order + 1);
				const turn = turnsById.get(turnKey(sessionId, result.record.call.turn_id));
				calls.push({
					...result.record.call,
					session_id: sessionId,
					order,
					definition_tokens: turn?.definitions.get(result.record.call.tool_name) ?? 0,
				});
				break;
			}
			case "ignored":
				break;
			default:
				assertNever(result.record);
		}
	}

	return { calls, turns, sessionIds, diagnostics };
}

function turnKey(sessionId: string, turnId: string): string {
	return `${sessionId}\0${turnId}`;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected decoded telemetry event: ${JSON.stringify(value)}`);
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
