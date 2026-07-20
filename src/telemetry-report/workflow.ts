import type { CanonicalCall } from "./model.js";
import { canonicalJson } from "./normalize.js";
import type {
	CandidateConversionRow,
	FailureRecoveryKind,
	FailureRecoveryRow,
	NearRetryRow,
	ToolOscillationRow,
	ToolTransitionRow,
} from "./types.js";

const RECOVERY_WINDOW = 3;

interface TransitionState {
	fromTool: string;
	fromCohortId: string;
	toTool: string;
	toCohortId: string;
	count: number;
	sessions: Set<string>;
	sameTurn: number;
	crossTurn: number;
	sameTarget: number;
	fromOutcomes: Map<string, number>;
	toOutcomes: Map<string, number>;
}

interface ConversionState {
	producerTool: string;
	producerCohortId: string;
	source: string;
	group: string;
	candidates: number;
	converted: number;
	exposedSessions: Set<string>;
	convertedSessions: Set<string>;
	top1Candidates: number;
	top1Converted: number;
	top3Candidates: number;
	top3Converted: number;
	convertedRankTotal: number;
	callsToUseTotal: number;
	consumers: Map<string, number>;
}

export interface WorkflowAnalysis {
	transitions: ToolTransitionRow[];
	candidateConversions: CandidateConversionRow[];
	candidateExposures: number;
	convertedCandidates: number;
	failureRecoveries: FailureRecoveryRow[];
	nearRetries: NearRetryRow[];
	toolOscillations: ToolOscillationRow[];
}

export function analyzeWorkflow(calls: readonly CanonicalCall[]): WorkflowAnalysis {
	const sessions = groupBySession(calls);
	const conversions = buildCandidateConversions(sessions);
	return {
		transitions: buildTransitions(sessions),
		candidateConversions: conversions.rows,
		candidateExposures: conversions.exposures,
		convertedCandidates: conversions.converted,
		failureRecoveries: buildFailureRecoveries(sessions),
		nearRetries: findNearRetries(sessions),
		toolOscillations: findToolOscillations(sessions),
	};
}

function buildTransitions(sessions: ReadonlyMap<string, readonly CanonicalCall[]>): ToolTransitionRow[] {
	const states = new Map<string, TransitionState>();
	const outgoing = new Map<string, number>();
	const destinations = new Map<string, number>();
	let total = 0;
	for (const [sessionId, calls] of sessions) {
		for (let index = 1; index < calls.length; index += 1) {
			const previous = calls[index - 1];
			const current = calls[index];
			if (previous === undefined || current === undefined) continue;
			const key = `${previous.tool_name}\0${previous.cohort_id}\0${current.tool_name}\0${current.cohort_id}`;
			const state = states.get(key) ?? {
				fromTool: previous.tool_name,
				fromCohortId: previous.cohort_id,
				toTool: current.tool_name,
				toCohortId: current.cohort_id,
				count: 0,
				sessions: new Set<string>(),
				sameTurn: 0,
				crossTurn: 0,
				sameTarget: 0,
				fromOutcomes: new Map<string, number>(),
				toOutcomes: new Map<string, number>(),
			};
			state.count += 1;
			state.sessions.add(sessionId);
			if (previous.turn_id === current.turn_id) state.sameTurn += 1;
			else state.crossTurn += 1;
			if (sharesInputTarget(previous, current)) state.sameTarget += 1;
			increment(state.fromOutcomes, previous.outcome);
			increment(state.toOutcomes, current.outcome);
			states.set(key, state);
			increment(outgoing, `${previous.tool_name}\0${previous.cohort_id}`);
			increment(destinations, `${current.tool_name}\0${current.cohort_id}`);
			total += 1;
		}
	}
	return [...states.values()].map((state) => {
		const outgoingCount = outgoing.get(`${state.fromTool}\0${state.fromCohortId}`) ?? 0;
		const probability = outgoingCount === 0 ? 0 : state.count / outgoingCount;
		const baseline = total === 0 ? 0 : (destinations.get(`${state.toTool}\0${state.toCohortId}`) ?? 0) / total;
		return {
			from_tool: state.fromTool,
			from_cohort_id: state.fromCohortId,
			to_tool: state.toTool,
			to_cohort_id: state.toCohortId,
			count: state.count,
			sessions: state.sessions.size,
			probability: rounded(probability),
			lift: baseline === 0 ? 0 : rounded(probability / baseline),
			same_turn: state.sameTurn,
			cross_turn: state.crossTurn,
			same_target: state.sameTarget,
			from_outcome_counts: sortedObject(state.fromOutcomes),
			to_outcome_counts: sortedObject(state.toOutcomes),
		};
	}).sort((left, right) => compare(left.from_tool, right.from_tool) || compare(left.from_cohort_id, right.from_cohort_id)
		|| compare(left.to_tool, right.to_tool) || compare(left.to_cohort_id, right.to_cohort_id));
}

function buildCandidateConversions(sessions: ReadonlyMap<string, readonly CanonicalCall[]>): {
	rows: CandidateConversionRow[];
	exposures: number;
	converted: number;
} {
	const states = new Map<string, ConversionState>();
	let exposures = 0;
	let converted = 0;
	for (const [sessionId, calls] of sessions) {
		for (let producerIndex = 0; producerIndex < calls.length; producerIndex += 1) {
			const producer = calls[producerIndex];
			if (producer === undefined) continue;
			for (const candidate of producer.candidates) {
				const match = findCandidateConsumer(calls, producerIndex, targetKey(candidate.kind, candidate.value));
				exposures += 1;
				if (match !== undefined) converted += 1;
				for (const source of candidate.sources.length === 0 ? ["unknown"] : candidate.sources) {
					const key = `${producer.tool_name}\0${producer.cohort_id}\0${source}\0${candidate.group}`;
					const state = states.get(key) ?? {
						producerTool: producer.tool_name,
						producerCohortId: producer.cohort_id,
						source,
						group: candidate.group,
						candidates: 0,
						converted: 0,
						exposedSessions: new Set<string>(),
						convertedSessions: new Set<string>(),
						top1Candidates: 0,
						top1Converted: 0,
						top3Candidates: 0,
						top3Converted: 0,
						convertedRankTotal: 0,
						callsToUseTotal: 0,
						consumers: new Map<string, number>(),
					};
					state.candidates += 1;
					state.exposedSessions.add(sessionId);
					if (candidate.rank <= 1) state.top1Candidates += 1;
					if (candidate.rank <= 3) state.top3Candidates += 1;
					if (match !== undefined) {
						state.converted += 1;
						state.convertedSessions.add(sessionId);
						state.convertedRankTotal += candidate.rank;
						state.callsToUseTotal += match.distance;
						if (candidate.rank <= 1) state.top1Converted += 1;
						if (candidate.rank <= 3) state.top3Converted += 1;
						increment(state.consumers, match.call.tool_name);
					}
					states.set(key, state);
				}
			}
		}
	}
	const rows = [...states.values()].map((state) => ({
		producer_tool: state.producerTool,
		producer_cohort_id: state.producerCohortId,
		source: state.source,
		group: state.group,
		candidates: state.candidates,
		converted: state.converted,
		conversion_rate: ratio(state.converted, state.candidates),
		exposed_sessions: state.exposedSessions.size,
		converted_sessions: state.convertedSessions.size,
		top_1_candidates: state.top1Candidates,
		top_1_converted: state.top1Converted,
		top_1_conversion_rate: ratio(state.top1Converted, state.top1Candidates),
		top_3_candidates: state.top3Candidates,
		top_3_converted: state.top3Converted,
		top_3_conversion_rate: ratio(state.top3Converted, state.top3Candidates),
		average_converted_rank: ratio(state.convertedRankTotal, state.converted),
		average_calls_to_use: ratio(state.callsToUseTotal, state.converted),
		consumer_counts: sortedObject(state.consumers),
	})).sort((left, right) => compare(left.producer_tool, right.producer_tool)
		|| compare(left.producer_cohort_id, right.producer_cohort_id)
		|| compare(left.source, right.source)
		|| compare(left.group, right.group));
	return { rows, exposures, converted };
}

function buildFailureRecoveries(sessions: ReadonlyMap<string, readonly CanonicalCall[]>): FailureRecoveryRow[] {
	const rows: FailureRecoveryRow[] = [];
	for (const [sessionId, calls] of sessions) {
		for (let failedIndex = 0; failedIndex < calls.length; failedIndex += 1) {
			const failed = calls[failedIndex];
			if (failed === undefined || failed.ok !== false) continue;
			const candidates = calls.slice(failedIndex + 1, failedIndex + 1 + RECOVERY_WINDOW);
			const recoveryIndex = candidates.findIndex((call) => call.ok === true);
			if (recoveryIndex < 0) {
				rows.push(unrecovered(sessionId, failed));
				continue;
			}
			const recovery = candidates[recoveryIndex];
			if (recovery === undefined) {
				rows.push(unrecovered(sessionId, failed));
				continue;
			}
			const path = candidates.slice(0, recoveryIndex + 1);
			rows.push({
				session_id: sessionId,
				failed_call_id: failed.tool_call_id,
				failed_tool: failed.tool_name,
				failure_outcome: failed.outcome,
				kind: recoveryKind(failed, recovery),
				recovery_call_id: recovery.tool_call_id,
				recovery_tool: recovery.tool_name,
				calls_to_recovery: recoveryIndex + 1,
				recovery_execution_ms: sum(path.map((call) => call.duration_ms ?? 0)),
				recovery_output_tokens: sum(path.map((call) => call.output_tokens ?? 0)),
			});
		}
	}
	return rows;
}

function findNearRetries(sessions: ReadonlyMap<string, readonly CanonicalCall[]>): NearRetryRow[] {
	const rows: NearRetryRow[] = [];
	for (const [sessionId, calls] of sessions) {
		for (let index = 1; index < calls.length; index += 1) {
			const previous = calls[index - 1];
			const current = calls[index];
			if (previous === undefined || current === undefined) continue;
			if (previous.ok !== false || previous.tool_name !== current.tool_name || previous.cohort_id !== current.cohort_id || previous.input_key === current.input_key) continue;
			rows.push({
				session_id: sessionId,
				previous_call_id: previous.tool_call_id,
				call_id: current.tool_call_id,
				tool: current.tool_name,
				previous_outcome: previous.outcome,
				outcome: current.outcome,
				changed_fields: changedFields(previous.input, current.input),
			});
		}
	}
	return rows;
}

function findToolOscillations(sessions: ReadonlyMap<string, readonly CanonicalCall[]>): ToolOscillationRow[] {
	const rows: ToolOscillationRow[] = [];
	for (const [sessionId, calls] of sessions) {
		for (let index = 2; index < calls.length; index += 1) {
			const first = calls[index - 2];
			const middle = calls[index - 1];
			const last = calls[index];
			if (first === undefined || middle === undefined || last === undefined) continue;
			if (first.tool_name !== last.tool_name || first.cohort_id !== last.cohort_id || first.tool_name === middle.tool_name) continue;
			rows.push({
				session_id: sessionId,
				first_call_id: first.tool_call_id,
				middle_call_id: middle.tool_call_id,
				last_call_id: last.tool_call_id,
				pattern: `${first.tool_name} -> ${middle.tool_name} -> ${last.tool_name}`,
				same_turn: first.turn_id === middle.turn_id && middle.turn_id === last.turn_id,
				same_target: sharesInputTarget(first, last),
				outcomes: [first.outcome, middle.outcome, last.outcome],
			});
		}
	}
	return rows;
}

function findCandidateConsumer(
	calls: readonly CanonicalCall[],
	producerIndex: number,
	candidateKey: string,
): { call: CanonicalCall; distance: number } | undefined {
	for (let index = producerIndex + 1; index < calls.length; index += 1) {
		const call = calls[index];
		if (call !== undefined && inputTargetKeys(call).has(candidateKey)) return { call, distance: index - producerIndex };
	}
	return undefined;
}

function recoveryKind(failed: CanonicalCall, recovery: CanonicalCall): Exclude<FailureRecoveryKind, "unrecovered"> {
	if (failed.tool_name !== recovery.tool_name || failed.cohort_id !== recovery.cohort_id) return "fallback";
	return failed.input_key === recovery.input_key ? "exact_retry" : "modified_retry";
}

function unrecovered(sessionId: string, failed: CanonicalCall): FailureRecoveryRow {
	return {
		session_id: sessionId,
		failed_call_id: failed.tool_call_id,
		failed_tool: failed.tool_name,
		failure_outcome: failed.outcome,
		kind: "unrecovered",
		recovery_execution_ms: 0,
		recovery_output_tokens: 0,
	};
}

function sharesInputTarget(left: CanonicalCall, right: CanonicalCall): boolean {
	const leftTargets = inputTargetKeys(left);
	for (const target of inputTargetKeys(right)) {
		if (leftTargets.has(target)) return true;
	}
	return false;
}

function inputTargetKeys(call: CanonicalCall): Set<string> {
	return new Set(call.input_references.map((reference) => targetKey(reference.kind, reference.value)));
}

function targetKey(kind: string, value: string): string {
	const category = kind === "url" ? "url" : kind === "file" || kind === "directory" || kind === "path" || kind === "region" ? "path" : kind;
	return `${category}\0${value}`;
}

function changedFields(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	return [...keys].filter((key) => Object.hasOwn(left, key) !== Object.hasOwn(right, key)
		|| canonicalJson(left[key]) !== canonicalJson(right[key])).sort(compare);
}

function groupBySession(calls: readonly CanonicalCall[]): Map<string, CanonicalCall[]> {
	const result = new Map<string, CanonicalCall[]>();
	for (const call of calls) {
		const values = result.get(call.session_id);
		if (values === undefined) result.set(call.session_id, [call]);
		else values.push(call);
	}
	return result;
}

function increment(values: Map<string, number>, key: string): void {
	values.set(key, (values.get(key) ?? 0) + 1);
}

function sortedObject(values: ReadonlyMap<string, number>): Record<string, number> {
	return Object.fromEntries([...values.entries()].sort(([left], [right]) => compare(left, right)));
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : rounded(numerator / denominator);
}

function rounded(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
