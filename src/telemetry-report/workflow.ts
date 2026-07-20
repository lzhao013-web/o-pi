import type { CanonicalCall, CanonicalCandidate, CanonicalReference } from "./model.js";
import { canonicalJson } from "./normalize.js";
import type {
	CandidateConversionRow,
	FailureRecoveryKind,
	FailureRecoveryRow,
	NearRetryRow,
	RepeatedCallRow,
	ToolOscillationRow,
	ToolTransitionRow,
	WorkflowEvidence,
	WorkflowReport,
} from "./types.js";

const CALL_WINDOW = 5;
const CONVERSION_CALL_WINDOW = 10;
const TIME_WINDOW_MS = 5 * 60_000;

export function analyzeWorkflow(calls: readonly CanonicalCall[]): WorkflowReport {
	const groups = workflowGroups(calls);
	const excluded = new Map<string, number>();
	const conversions = candidateConversions(groups, excluded);
	return {
		heuristic: true,
		method: "bounded interaction+branch chains; parallel batches and overlapping execution intervals are non-causal",
		transitions: transitions(groups, excluded),
		repeated_calls: repeatedCalls(groups, excluded),
		candidate_conversions: conversions,
		failure_recoveries: failureRecoveries(groups, excluded),
		near_retries: nearRetries(groups, excluded),
		tool_oscillations: oscillations(groups, excluded),
		excluded: sortedObject(excluded),
	};
}

function transitions(groups: ReadonlyMap<string, readonly CanonicalCall[]>, excluded: Map<string, number>): ToolTransitionRow[] {
	const states = new Map<string, { from: CanonicalCall; to: CanonicalCall; count: number; sessions: Set<string>; sameTarget: number }>();
	for (const calls of groups.values()) {
		for (let index = 1; index < calls.length; index += 1) {
			const from = calls[index - 1];
			const to = calls[index];
			if (from === undefined || to === undefined || !eligiblePair(from, to, excluded)) continue;
			const key = `${from.slice_id}\0${to.slice_id}`;
			const state = states.get(key) ?? { from, to, count: 0, sessions: new Set<string>(), sameTarget: 0 };
			state.count += 1;
			state.sessions.add(from.session_id);
			if (sharesTarget(from, to)) state.sameTarget += 1;
			states.set(key, state);
		}
	}
	return [...states.values()].map((state) => ({
		from_slice_id: state.from.slice_id,
		from_tool: state.from.tool_name,
		to_slice_id: state.to.slice_id,
		to_tool: state.to.tool_name,
		count: state.count,
		sessions: state.sessions.size,
		same_target: state.sameTarget,
		evidence: evidence(state.sameTarget === state.count ? "moderate" : "weak", ["bounded_order", ...(state.sameTarget > 0 ? ["shared_target"] : [])]),
	})).sort((left, right) => compare(left.from_slice_id, right.from_slice_id) || compare(left.to_slice_id, right.to_slice_id));
}

function repeatedCalls(groups: ReadonlyMap<string, readonly CanonicalCall[]>, excluded: Map<string, number>): RepeatedCallRow[] {
	const rows: RepeatedCallRow[] = [];
	for (const calls of groups.values()) {
		const latest = new Map<string, { call: CanonicalCall; index: number }>();
		for (let index = 0; index < calls.length; index += 1) {
			const call = calls[index];
			if (call === undefined) continue;
			const previous = latest.get(call.input_key);
			if (previous !== undefined && index - previous.index <= CALL_WINDOW && eligiblePair(previous.call, call, excluded)) {
				if (resourceChanged(calls, previous.index, index, previous.call, call)) increment(excluded, "repeat_after_resource_change");
				else rows.push({
					session_id: call.session_id,
					previous_call_id: previous.call.tool_call_id,
					call_id: call.tool_call_id,
					slice_id: call.slice_id,
					tool: call.tool_name,
					kind: previous.call.ok === false ? "failure_retry" : "success_duplicate",
					evidence: evidence("moderate", ["same_normalized_input", "no_observed_resource_change"]),
				});
			}
			latest.set(call.input_key, { call, index });
		}
	}
	return rows;
}

function candidateConversions(groups: ReadonlyMap<string, readonly CanonicalCall[]>, excluded: Map<string, number>): CandidateConversionRow[] {
	interface State {
		producer: CanonicalCall;
		source: string;
		group: string;
		candidates: number;
		strong: number;
		weak: number;
		exposedSessions: Set<string>;
		convertedSessions: Set<string>;
		consumers: Map<string, number>;
	}
	const states = new Map<string, State>();
	for (const calls of groups.values()) {
		for (let producerIndex = 0; producerIndex < calls.length; producerIndex += 1) {
			const producer = calls[producerIndex];
			if (producer === undefined) continue;
			for (const candidate of producer.candidates) {
				const match = findConsumer(calls, producerIndex, candidate, excluded);
				for (const source of candidate.sources.length === 0 ? ["unknown"] : candidate.sources.map((item) => item.id)) {
					const key = `${producer.slice_id}\0${source}\0${candidate.group}`;
					const state = states.get(key) ?? {
						producer, source, group: candidate.group, candidates: 0, strong: 0, weak: 0,
						exposedSessions: new Set<string>(), convertedSessions: new Set<string>(), consumers: new Map<string, number>(),
					};
					state.candidates += 1;
					state.exposedSessions.add(producer.session_id);
					if (match !== undefined) {
						if (match.strength === "strong") state.strong += 1;
						else state.weak += 1;
						state.convertedSessions.add(producer.session_id);
						increment(state.consumers, match.call.tool_name);
					}
					states.set(key, state);
				}
			}
		}
	}
	return [...states.values()].map((state) => ({
		producer_slice_id: state.producer.slice_id,
		producer_tool: state.producer.tool_name,
		source: state.source,
		group: state.group,
		candidates: state.candidates,
		strong_conversions: state.strong,
		weak_conversions: state.weak,
		strong_conversion_rate: ratio(state.strong, state.candidates),
		weak_conversion_rate: ratio(state.weak, state.candidates),
		exposed_sessions: state.exposedSessions.size,
		converted_sessions: state.convertedSessions.size,
		consumer_counts: sortedObject(state.consumers),
		evidence: evidence("moderate", ["bounded_region_overlap", "whole_file_is_weak"]),
	})).sort((left, right) => compare(left.producer_slice_id, right.producer_slice_id) || compare(left.source, right.source) || compare(left.group, right.group));
}

function failureRecoveries(groups: ReadonlyMap<string, readonly CanonicalCall[]>, excluded: Map<string, number>): FailureRecoveryRow[] {
	const rows: FailureRecoveryRow[] = [];
	for (const calls of groups.values()) {
		for (let index = 0; index < calls.length; index += 1) {
			const failed = calls[index];
			if (failed === undefined || failed.ok !== false) continue;
			let match: { call: CanonicalCall; distance: number } | undefined;
			for (let offset = 1; offset <= CALL_WINDOW; offset += 1) {
				const call = calls[index + offset];
				if (call === undefined || !withinTime(failed, call)) break;
				if (!eligiblePair(failed, call, excluded)) continue;
				if (call.ok === true && (call.tool_name === failed.tool_name || sharesTarget(failed, call))) {
					match = { call, distance: offset };
					break;
				}
			}
			rows.push(match === undefined ? {
				session_id: failed.session_id,
				failed_call_id: failed.tool_call_id,
				failed_tool: failed.tool_name,
				failure_outcome: failed.outcome,
				kind: "unrecovered",
				evidence: evidence("weak", ["no_bounded_matching_success"]),
			} : {
				session_id: failed.session_id,
				failed_call_id: failed.tool_call_id,
				failed_tool: failed.tool_name,
				failure_outcome: failed.outcome,
				kind: recoveryKind(failed, match.call),
				recovery_call_id: match.call.tool_call_id,
				recovery_tool: match.call.tool_name,
				calls_to_recovery: match.distance,
				evidence: evidence(sharesTarget(failed, match.call) ? "moderate" : "weak", ["bounded_success", ...(sharesTarget(failed, match.call) ? ["shared_target"] : [])]),
			});
		}
	}
	return rows;
}

function nearRetries(groups: ReadonlyMap<string, readonly CanonicalCall[]>, excluded: Map<string, number>): NearRetryRow[] {
	const rows: NearRetryRow[] = [];
	for (const calls of groups.values()) {
		for (let index = 1; index < calls.length; index += 1) {
			const previous = calls[index - 1];
			const current = calls[index];
			if (previous === undefined || current === undefined || previous.ok !== false || previous.slice_id !== current.slice_id
				|| previous.input_key === current.input_key || !eligiblePair(previous, current, excluded)) continue;
			if (!sharesTarget(previous, current)) continue;
			rows.push({
				session_id: current.session_id,
				previous_call_id: previous.tool_call_id,
				call_id: current.tool_call_id,
				tool: current.tool_name,
				changed_fields: changedFields(previous.input, current.input),
				evidence: evidence("moderate", ["same_slice", "shared_target", "adjacent_in_chain"]),
			});
		}
	}
	return rows;
}

function oscillations(groups: ReadonlyMap<string, readonly CanonicalCall[]>, excluded: Map<string, number>): ToolOscillationRow[] {
	const rows: ToolOscillationRow[] = [];
	for (const calls of groups.values()) {
		for (let index = 2; index < calls.length; index += 1) {
			const first = calls[index - 2];
			const middle = calls[index - 1];
			const last = calls[index];
			if (first === undefined || middle === undefined || last === undefined || first.slice_id !== last.slice_id || first.tool_name === middle.tool_name) continue;
			if (!eligiblePair(first, middle, excluded) || !eligiblePair(middle, last, excluded) || !sharesTarget(first, last)) continue;
			rows.push({
				session_id: first.session_id,
				first_call_id: first.tool_call_id,
				middle_call_id: middle.tool_call_id,
				last_call_id: last.tool_call_id,
				pattern: `${first.tool_name} -> ${middle.tool_name} -> ${last.tool_name}`,
				evidence: evidence("moderate", ["same_slice_return", "shared_target", "bounded_chain"]),
			});
		}
	}
	return rows;
}

function findConsumer(calls: readonly CanonicalCall[], producerIndex: number, candidate: CanonicalCandidate, excluded: Map<string, number>): { call: CanonicalCall; strength: "strong" | "weak" } | undefined {
	const producer = calls[producerIndex];
	if (producer === undefined) return undefined;
	for (let offset = 1; offset <= CONVERSION_CALL_WINDOW; offset += 1) {
		const call = calls[producerIndex + offset];
		if (call === undefined || !withinTime(producer, call)) break;
		if (!eligiblePair(producer, call, excluded)) continue;
		if (candidateInvalidated(calls, producerIndex, producerIndex + offset, candidate)) {
			increment(excluded, "candidate_after_resource_change");
			return undefined;
		}
		for (const reference of call.input_references) {
			const strength = referenceMatch(candidate, reference);
			if (strength !== undefined) return { call, strength };
		}
	}
	return undefined;
}

function referenceMatch(candidate: CanonicalReference, consumer: CanonicalReference): "strong" | "weak" | undefined {
	if (targetCategory(candidate.kind) !== targetCategory(consumer.kind) || candidate.value !== consumer.value) return undefined;
	const candidateRevision = revision(candidate);
	const consumerRevision = revision(consumer);
	if (candidateRevision !== undefined && consumerRevision !== undefined && candidateRevision !== consumerRevision) return undefined;
	const candidateRange = lineRange(candidate);
	const consumerRange = lineRange(consumer);
	if (candidateRange !== undefined && consumerRange !== undefined) {
		return candidateRange.start <= consumerRange.end && consumerRange.start <= candidateRange.end ? "strong" : undefined;
	}
	if (candidateRange === undefined && consumerRange === undefined) return targetCategory(candidate.kind) === "path" ? "weak" : "strong";
	return "weak";
}

function candidateInvalidated(calls: readonly CanonicalCall[], producerIndex: number, consumerIndex: number, candidate: CanonicalReference): boolean {
	const target = new Set([targetKey(candidate)]);
	for (let index = producerIndex + 1; index < consumerIndex; index += 1) {
		const call = calls[index];
		if (call !== undefined && modifiesAny(call, target)) return true;
	}
	return false;
}

function eligiblePair(left: CanonicalCall, right: CanonicalCall, excluded: Map<string, number>): boolean {
	if (millis(left.timing.event_at) === undefined || millis(right.timing.event_at) === undefined) {
		increment(excluded, "missing_event_time");
		return false;
	}
	if (!withinTime(left, right)) {
		increment(excluded, "outside_time_window");
		return false;
	}
	if (left.context.tool_batch?.id !== undefined && left.context.tool_batch.id === right.context.tool_batch?.id) {
		increment(excluded, "same_parallel_batch");
		return false;
	}
	if (overlapsExecution(left, right)) {
		increment(excluded, "overlapping_execution");
		return false;
	}
	return true;
}

function overlapsExecution(left: CanonicalCall, right: CanonicalCall): boolean {
	const leftStart = millis(left.timing.execution_started_at);
	const leftEnd = millis(left.timing.execution_ended_at);
	const rightStart = millis(right.timing.execution_started_at);
	const rightEnd = millis(right.timing.execution_ended_at);
	return leftStart !== undefined && leftEnd !== undefined && rightStart !== undefined && rightEnd !== undefined
		&& leftStart < rightEnd && rightStart < leftEnd;
}

function withinTime(left: CanonicalCall, right: CanonicalCall): boolean {
	const leftTime = millis(left.timing.event_at);
	const rightTime = millis(right.timing.event_at);
	return leftTime !== undefined && rightTime !== undefined && rightTime >= leftTime && rightTime - leftTime <= TIME_WINDOW_MS;
}

function resourceChanged(calls: readonly CanonicalCall[], previousIndex: number, currentIndex: number, previous: CanonicalCall, current: CanonicalCall): boolean {
	const previousRevisions = targetRevisions(previous.input_references);
	const currentRevisions = targetRevisions(current.input_references);
	for (const [target, revisionValue] of previousRevisions) {
		const next = currentRevisions.get(target);
		if (next !== undefined && next !== revisionValue) return true;
	}
	const targets = targetValues(previous.input_references);
	for (let index = previousIndex + 1; index < currentIndex; index += 1) {
		const intermediate = calls[index];
		if (intermediate !== undefined && modifiesAny(intermediate, targets)) return true;
	}
	return false;
}

function modifiesAny(call: CanonicalCall, targets: ReadonlySet<string>): boolean {
	const modifyingTool = /^(edit|write|patch|apply_patch|delete|move|rename)$/iu.test(call.tool_name);
	for (const reference of [...call.input_references, ...call.result_references]) {
		if (!targets.has(targetKey(reference)) || (!modifyingTool && !/^(modified|written|updated|deleted|created)$/iu.test(reference.relation))) continue;
		return true;
	}
	return false;
}

function recoveryKind(failed: CanonicalCall, recovered: CanonicalCall): Exclude<FailureRecoveryKind, "unrecovered"> {
	if (failed.slice_id !== recovered.slice_id) return "fallback";
	return failed.input_key === recovered.input_key ? "exact_retry" : "modified_retry";
}

function workflowGroups(calls: readonly CanonicalCall[]): Map<string, CanonicalCall[]> {
	const groups = new Map<string, CanonicalCall[]>();
	for (const call of calls) {
		const interaction = call.context.interaction ?? `turn:${call.turn_id}`;
		const branch = call.context.branch?.lineage_hash ?? `branch:unknown:${call.turn_id}`;
		const key = `${call.session_id}\0${interaction}\0${branch}`;
		const values = groups.get(key);
		if (values === undefined) groups.set(key, [call]);
		else values.push(call);
	}
	for (const values of groups.values()) values.sort((left, right) => eventTime(left) - eventTime(right) || left.sequence - right.sequence || left.order - right.order);
	return groups;
}

function sharesTarget(left: CanonicalCall, right: CanonicalCall): boolean {
	const targets = targetValues(left.input_references);
	return [...targetValues(right.input_references)].some((target) => targets.has(target));
}

function targetValues(references: readonly CanonicalReference[]): Set<string> {
	return new Set(references.map(targetKey));
}

function targetRevisions(references: readonly CanonicalReference[]): Map<string, string> {
	const result = new Map<string, string>();
	for (const reference of references) {
		const value = revision(reference);
		if (value !== undefined) result.set(targetKey(reference), value);
	}
	return result;
}

function targetKey(reference: CanonicalReference): string {
	return `${targetCategory(reference.kind)}\0${reference.value}`;
}

function targetCategory(kind: string): string {
	return kind === "url" ? "url" : ["file", "directory", "path", "region"].includes(kind) ? "path" : kind;
}

function revision(reference: CanonicalReference): string | undefined {
	return reference.resource?.revision ?? reference.resource?.content_hash?.value ?? reference.resource?.snapshot;
}

function lineRange(reference: CanonicalReference): { start: number; end: number } | undefined {
	const start = reference.resource?.start_line;
	const end = reference.resource?.end_line;
	return start === undefined || end === undefined ? undefined : { start, end };
}

function changedFields(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	return [...keys].filter((key) => Object.hasOwn(left, key) !== Object.hasOwn(right, key) || canonicalJson(left[key]) !== canonicalJson(right[key])).sort(compare);
}

function evidence(confidence: WorkflowEvidence["confidence"], reasons: string[]): WorkflowEvidence {
	return { heuristic: true, confidence, reasons };
}

function eventTime(call: CanonicalCall): number {
	return millis(call.timing.call_started_at ?? call.timing.event_at) ?? call.sequence;
}

function millis(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function increment(values: Map<string, number>, key: string): void {
	values.set(key, (values.get(key) ?? 0) + 1);
}

function sortedObject(values: ReadonlyMap<string, number>): Record<string, number> {
	return Object.fromEntries([...values].sort(([left], [right]) => compare(left, right)));
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
