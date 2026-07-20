import { readTelemetryRecord } from "./reader.js";
import { canonicalJson } from "./normalize.js";
import type { CanonicalCall, CanonicalCallFragment, CanonicalDataset, CanonicalEvent, CanonicalTurn, DecodeContext, IngestDiagnostics } from "./model.js";

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
	const runStates = new Map<string, "open" | "closed">();
	const runStateTimes = new Map<string, string>();
	const cwdBySession = new Map<string, string>();
	const orderBySession = new Map<string, number>();
	const turnsById = new Map<string, CanonicalTurn>();
	const eventIds = new Set<string>();
	const fragments = new Map<string, { sessionId: string; values: Array<{ call: CanonicalCallFragment; status: "known" | "partial"; issues: string[] }> }>();
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
		const envelopeRunId = raw === undefined ? undefined : string(raw["run_id"]);
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
				setSessionState(runStates, runStateTimes, runStateKey(sessionId, envelopeRunId ?? eventId), "open", timestamp);
				break;
			case "session_end":
				setSessionState(runStates, runStateTimes, runStateKey(sessionId, envelopeRunId ?? eventId), "closed", timestamp);
				if ((result.record.unfinished_call_count ?? 0) > 0) collectionIssues.push({ issue: "unfinished_call", count: result.record.unfinished_call_count ?? 0, session_id: sessionId });
				break;
			case "turn_start": {
				const key = turnKey(sessionId, result.record.turn.id);
				const existing = turnsById.get(key);
				if (existing === undefined) {
					const turn: CanonicalTurn = { ...result.record.turn, session_id: sessionId };
					turns.push(turn);
					turnsById.set(key, turn);
				} else Object.assign(existing, result.record.turn);
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
			case "tool_call_fragment": {
				const key = callKey(sessionId, result.record.call.run_id, result.record.call.tool_call_id);
				const state = fragments.get(key);
				const item: { call: CanonicalCallFragment; status: "known" | "partial"; issues: string[] } = { call: result.record.call, status: result.status, issues: [...result.issues] };
				if (state === undefined) fragments.set(key, { sessionId, values: [item] });
				else state.values.push(item);
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
	for (const state of fragments.values()) {
		const values = state.values;
		values.sort((left, right) => left.call.sequence - right.call.sequence);
		const first = values[0];
		if (first === undefined) continue;
		const call = materializeCall(values.map((value) => value.call));
		call.session_id = state.sessionId;
		const order = orderBySession.get(call.session_id) ?? 0;
		orderBySession.set(call.session_id, order + 1);
		const turn = turnsById.get(turnKey(call.session_id, call.turn_id));
		if (turn !== undefined) call.context.repo_map = turn.repo_map;
		const exposure = turn?.exposures.find((item) => item.name === call.tool_name
			&& item.identity.behavior_hash === call.identity.behavior_hash
			&& item.identity.instrumentation_hash === call.identity.instrumentation_hash
			&& item.identity.config_hash === call.identity.config_hash);
		call.order = order;
		if (exposure?.definition_tokens !== undefined) call.definition_tokens = exposure.definition_tokens;
		call.decode_status = values.some((value) => value.status === "partial") ? "partial" : "known";
		call.decode_issues = [...new Set(values.flatMap((value) => value.issues))];
		calls.push(call);
	}

	diagnostics.decode_issue_counts = sortedObject(issueCounts);
	for (const sessionId of sessionIds) {
		const states = [...runStates].filter(([key]) => key.startsWith(`${sessionId}\0`)).map(([, state]) => state);
		if (states.length > 0) sessionStates.set(sessionId, states.every((state) => state === "closed") ? "closed" : "open");
	}
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
	const runId = string(raw["run_id"]);
	const streamId = string(raw["stream_id"]);
	return {
		id,
		event: string(raw["event"]) ?? "unknown",
		session_id: sessionId,
		...(runId === undefined ? {} : { run_id: runId }),
		...(streamId === undefined ? {} : { stream_id: streamId }),
		...(sequence === undefined ? {} : { sequence }),
		...(timestamp === undefined ? {} : { timestamp }),
		...(turnId === undefined ? {} : { turn_id: turnId }),
		...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
		decode_status: status,
		issues: [...issues],
	};
}

function callOrder(left: CanonicalDataset["calls"][number], right: CanonicalDataset["calls"][number]): number {
	return compare(left.session_id, right.session_id) || compare(left.run_id, right.run_id) || left.sequence - right.sequence || left.order - right.order;
}

function materializeCall(fragments: readonly CanonicalCallFragment[]): CanonicalCall {
	const start = fragments.find((item) => item.phase === "start") ?? fragments[0];
	const execution = [...fragments].reverse().find((item) => item.phase === "execution_start");
	const end = [...fragments].reverse().find((item) => item.phase === "end");
	if (start === undefined) throw new Error("empty call lifecycle");
	if (end?.completed !== undefined) {
		const completed = end.completed;
		return {
			...completed,
			sequence: start.sequence,
			timing: { ...start.timing, ...execution?.timing, ...completed.timing },
			session_id: "",
			order: 0,
			decode_status: "known",
			decode_issues: [],
		};
	}
	const latest = execution ?? fragments.at(-1) ?? start;
	const requestedInput = latest.requested_input ?? start.requested_input ?? {};
	const requestedReferences = latest.requested_references ?? start.requested_references ?? [];
	const executedInput = latest.executed_input;
	const executedReferences = latest.executed_references;
	const selectedInput = executedInput ?? requestedInput;
	const selectedReferences = executedReferences ?? requestedReferences;
	const timing = { ...start.timing, ...latest.timing };
	return {
		session_id: "",
		run_id: start.run_id,
		turn_id: start.turn_id,
		...(start.turn_index === undefined ? {} : { turn_index: start.turn_index }),
		sequence: start.sequence,
		order: 0,
		tool_call_id: start.tool_call_id,
		tool_name: start.tool_name,
		phase: execution === undefined ? "declared" : "executing",
		terminal_status: "unfinished",
		slice_id: start.slice_id,
		identity: start.identity,
		context: start.context,
		timing,
		requested_input: requestedInput,
		requested_references: requestedReferences,
		...(executedInput === undefined ? {} : { executed_input: executedInput, executed_references: executedReferences ?? [] }),
		input: selectedInput,
		input_references: selectedReferences,
		input_key: canonicalJson({ tool: start.tool_name, behavior: start.identity.behavior_hash, instrumentation: start.identity.instrumentation_hash, config: start.identity.config_hash, input: selectedInput }),
		outcome: "unfinished",
		...(latest.preparation_status === undefined ? {} : { preparation_status: latest.preparation_status }),
		repair_operations: latest.repair_operations ?? [],
		...(latest.approval_outcome === undefined ? {} : { approval_outcome: latest.approval_outcome }),
		...(latest.approval_decision === undefined ? {} : { approval_decision: latest.approval_decision }),
		...(latest.approval_wait_ms === undefined ? {} : { approval_wait_ms: latest.approval_wait_ms }),
		...(latest.projection_failed === undefined ? {} : { projection_failed: latest.projection_failed }),
		...(latest.projection_limited === undefined ? {} : { projection_limited: latest.projection_limited }),
		candidates: [], result_references: [], metrics: {}, measurements: [], stages: [],
		decode_status: "known", decode_issues: [],
	};
}

function callKey(sessionId: string, runId: string, callId: string): string {
	return `${sessionId}\0${runId}\0${callId}`;
}

function turnKey(sessionId: string, turnId: string): string {
	return `${sessionId}\0${turnId}`;
}

function runStateKey(sessionId: string, runId: string): string {
	return `${sessionId}\0${runId}`;
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

function setSessionState(
	states: Map<string, "open" | "closed">,
	times: Map<string, string>,
	sessionId: string,
	state: "open" | "closed",
	timestamp: string | undefined,
): void {
	const time = timestamp ?? "";
	const previous = times.get(sessionId);
	if (previous !== undefined && previous > time) return;
	times.set(sessionId, time);
	states.set(sessionId, state);
}

function sortedObject(values: ReadonlyMap<string, number>): Record<string, number> {
	return Object.fromEntries([...values].sort(([left], [right]) => compare(left, right)));
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
