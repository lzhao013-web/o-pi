import { readTelemetryRecord } from "./reader.js";
import type { CanonicalDataset, CanonicalEvent, CanonicalTurn, DecodeContext, IngestDiagnostics } from "./model.js";

export interface IngestTelemetryOptions {
	defaultCwd?: string;
}

export function ingestTelemetryRecords(records: readonly unknown[], options: IngestTelemetryOptions = {}): CanonicalDataset {
	const calls: CanonicalDataset["calls"] = [];
	const turns: CanonicalTurn[] = [];
	const events: CanonicalEvent[] = [];
	const collectionIssues: CanonicalDataset["collectionIssues"] = [];
	const sessionIds = new Set<string>();
	const sessionStates = new Map<string, "open" | "closed">();
	const cwdBySession = new Map<string, string>();
	const orderBySession = new Map<string, number>();
	const turnsById = new Map<string, CanonicalTurn>();
	const eventIds = new Set<string>();
	const defaultCwd = options.defaultCwd ?? process.cwd();
	const issueCounts = new Map<string, number>();
	const diagnostics: IngestDiagnostics = {
		decoded_records: 0,
		partial_records: 0,
		unknown_events: 0,
		invalid_records: 0,
		duplicate_records: 0,
		decode_issue_counts: {},
	};
	let asOf: string | undefined;

	for (const value of records) {
		const raw = isRecord(value) ? value : undefined;
		const sessionId = raw === undefined ? undefined : string(raw["session_id"]);
		const timestamp = raw === undefined ? undefined : validTimestamp(raw["timestamp"]);
		if (timestamp !== undefined && (asOf === undefined || timestamp > asOf)) asOf = timestamp;
		const context: DecodeContext = { cwd: sessionId === undefined ? defaultCwd : cwdBySession.get(sessionId) ?? defaultCwd };
		const result = readTelemetryRecord(value, context);
		if (result.status === "invalid") {
			diagnostics.invalid_records += 1;
			for (const issue of result.issues) increment(issueCounts, issue);
			continue;
		}
		const eventId = raw === undefined ? undefined : string(raw["id"]);
		if (eventId !== undefined && eventIds.has(eventId)) {
			diagnostics.duplicate_records += 1;
			increment(issueCounts, "duplicate_event_id");
			continue;
		}
		if (eventId !== undefined) eventIds.add(eventId);
		if (sessionId !== undefined) sessionIds.add(sessionId);
		if (result.status === "unknown_event") {
			diagnostics.unknown_events += 1;
			if (sessionId !== undefined && eventId !== undefined && raw !== undefined) events.push(eventFact(raw, eventId, sessionId, "unknown", []));
			continue;
		}
		diagnostics.decoded_records += 1;
		if (result.status === "partial") diagnostics.partial_records += 1;
		for (const issue of result.issues) increment(issueCounts, issue);
		if (sessionId === undefined || eventId === undefined || raw === undefined) continue;
		events.push(eventFact(raw, eventId, sessionId, result.status, result.issues));

		switch (result.record.event) {
			case "session_start":
				cwdBySession.set(sessionId, result.record.cwd);
				sessionStates.set(sessionId, "open");
				break;
			case "session_end":
				sessionStates.set(sessionId, "closed");
				if ((result.record.unfinished_call_count ?? 0) > 0) collectionIssues.push({ issue: "unfinished_call", count: result.record.unfinished_call_count ?? 0, session_id: sessionId });
				break;
			case "turn_start": {
				const turn: CanonicalTurn = { ...result.record.turn, session_id: sessionId };
				turns.push(turn);
				turnsById.set(turnKey(sessionId, turn.id), turn);
				break;
			}
			case "turn_end": {
				const key = turnKey(sessionId, result.record.turn.id);
				const existing = turnsById.get(key);
				if (existing === undefined) {
					const turn: CanonicalTurn = { ...result.record.turn, session_id: sessionId, exposures: [] };
					turns.push(turn);
					turnsById.set(key, turn);
				} else Object.assign(existing, result.record.turn);
				break;
			}
			case "tool_call_start":
				break;
			case "tool_call": {
				const call = result.record.call;
				const order = orderBySession.get(sessionId) ?? 0;
				orderBySession.set(sessionId, order + 1);
				const turn = turnsById.get(turnKey(sessionId, call.turn_id));
				const exposure = turn?.exposures.find((item) => item.name === call.tool_name
					&& item.identity.behavior_hash === call.identity.behavior_hash
					&& item.identity.instrumentation_hash === call.identity.instrumentation_hash);
				calls.push({
					...call,
					session_id: sessionId,
					order,
					definition_tokens: exposure?.definition_tokens ?? 0,
					decode_status: result.status,
					decode_issues: [...result.issues],
				});
				break;
			}
			case "collection_health":
				collectionIssues.push(result.record.issue);
				break;
			case "ignored":
				break;
			default:
				assertNever(result.record);
		}
	}

	diagnostics.decode_issue_counts = sortedObject(issueCounts);
	return {
		calls: calls.sort(callOrder),
		turns,
		events,
		collectionIssues,
		sessionIds,
		sessionStates,
		diagnostics,
		...(asOf === undefined ? {} : { asOf }),
	};
}

function eventFact(raw: Record<string, unknown>, id: string, sessionId: string, status: CanonicalEvent["decode_status"], issues: readonly string[]): CanonicalEvent {
	const sequence = integer(raw["sequence"]);
	const timestamp = validTimestamp(raw["timestamp"]);
	const turnId = string(raw["turn_id"]);
	const toolCallId = string(raw["tool_call_id"]);
	return {
		id,
		event: string(raw["event"]) ?? "unknown",
		session_id: sessionId,
		...(sequence === undefined ? {} : { sequence }),
		...(timestamp === undefined ? {} : { timestamp }),
		...(turnId === undefined ? {} : { turn_id: turnId }),
		...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
		decode_status: status,
		issues: [...issues],
	};
}

function callOrder(left: CanonicalDataset["calls"][number], right: CanonicalDataset["calls"][number]): number {
	return compare(left.session_id, right.session_id) || left.sequence - right.sequence || left.order - right.order;
}

function turnKey(sessionId: string, turnId: string): string {
	return `${sessionId}\0${turnId}`;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected decoded telemetry event: ${JSON.stringify(value)}`);
}

function validTimestamp(value: unknown): string | undefined {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function integer(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function increment(values: Map<string, number>, key: string): void {
	values.set(key, (values.get(key) ?? 0) + 1);
}

function sortedObject(values: ReadonlyMap<string, number>): Record<string, number> {
	return Object.fromEntries([...values].sort(([left], [right]) => compare(left, right)));
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
