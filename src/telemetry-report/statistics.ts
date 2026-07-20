import { ingestTelemetryRecords } from "./ingest.js";
import type { CanonicalCall, CanonicalTurn } from "./model.js";
import type { ReportMetadata, ReportSnapshot, RepeatedCallRow, ToolMetricStatistic, ToolReportRow, ToolTransitionRow } from "./types.js";
import { analyzeWorkflow } from "./workflow.js";

interface Exposure {
	turns: number;
	unused: number;
	tokens: number;
	unusedTokens: number;
	latestDefinition: number;
}

interface NumericMetric {
	samples: number;
	total: number;
	min: number;
	max: number;
}

interface MetricState {
	numeric?: NumericMetric;
	booleans?: { true: number; false: number };
	strings?: Map<string, number>;
}

export interface CalculateTelemetryReportOptions {
	generatedAt?: string;
	inputDirectory?: string;
	inputFiles?: string[];
	invalidLines?: number;
}

export function calculateTelemetryReport(records: readonly unknown[], options: CalculateTelemetryReportOptions = {}): ReportSnapshot {
	const { calls, turns, sessionIds, diagnostics } = ingestTelemetryRecords(records);
	const workflow = analyzeWorkflow(calls);
	const repeated = findRepeatedCalls(calls);
	const tools = buildToolReports(calls, collectExposure(turns, calls), workflow.transitions, repeated);
	const successes = calls.filter((call) => call.ok === true).length;
	const errors = calls.filter((call) => call.ok === false).length;
	const recovered = workflow.failureRecoveries.filter((row) => row.kind !== "unrecovered");
	const candidateExposures = workflow.candidateExposures;
	const candidateConversions = workflow.convertedCandidates;
	const metadata: ReportMetadata = {
		generated_at: options.generatedAt ?? new Date().toISOString(),
		...(options.inputDirectory === undefined ? {} : { input_directory: options.inputDirectory }),
		input_files: [...(options.inputFiles ?? [])].sort(),
		parsed_lines: records.length,
		...diagnostics,
		invalid_lines: options.invalidLines ?? 0,
	};
	return {
		tools,
		tool_transitions: workflow.transitions,
		repeated_calls: repeated,
		candidate_conversions: workflow.candidateConversions,
		failure_recoveries: workflow.failureRecoveries,
		near_retries: workflow.nearRetries,
		tool_oscillations: workflow.toolOscillations,
		summary: {
			sessions: sessionIds.size,
			turns: turns.length,
			tools: new Set(tools.map((row) => row.tool)).size,
			calls: calls.length,
			successes,
			errors,
			unknown_results: calls.length - successes - errors,
			success_rate: ratio(successes, successes + errors),
			repeated_calls: repeated.length,
			failure_retries: repeated.filter((row) => row.kind === "failure_retry").length,
			near_retries: workflow.nearRetries.length,
			tool_oscillations: workflow.toolOscillations.length,
			candidate_exposures: candidateExposures,
			candidate_conversions: candidateConversions,
			candidate_conversion_rate: ratio(candidateConversions, candidateExposures),
			failed_calls: workflow.failureRecoveries.length,
			recovered_failures: recovered.length,
			failure_recovery_rate: ratio(recovered.length, workflow.failureRecoveries.length),
			exact_recoveries: recovered.filter((row) => row.kind === "exact_retry").length,
			modified_recoveries: recovered.filter((row) => row.kind === "modified_retry").length,
			fallback_recoveries: recovered.filter((row) => row.kind === "fallback").length,
			unrecovered_failures: workflow.failureRecoveries.filter((row) => row.kind === "unrecovered").length,
			output_tokens: sum(calls.map((call) => call.output_tokens ?? 0)),
			execution_ms: sum(calls.map((call) => call.duration_ms ?? 0)),
		},
		metadata,
	};
}

function buildToolReports(
	calls: readonly CanonicalCall[],
	exposures: Map<string, Exposure>,
	transitions: readonly ToolTransitionRow[],
	repeated: readonly RepeatedCallRow[],
): ToolReportRow[] {
	const groups = new Map<string, { tool: string; cohortId: string }>();
	for (const call of calls) groups.set(`${call.tool_name}\0${call.cohort_id}`, { tool: call.tool_name, cohortId: call.cohort_id });
	for (const tool of exposures.keys()) {
		if (![...groups.values()].some((group) => group.tool === tool)) groups.set(`${tool}\0not_observed`, { tool, cohortId: "not_observed" });
	}
	return [...groups.values()]
		.sort((left, right) => compare(left.tool, right.tool) || compare(left.cohortId, right.cohortId))
		.map(({ tool, cohortId }): ToolReportRow => {
		const toolCalls = calls.filter((call) => call.tool_name === tool && call.cohort_id === cohortId);
		const successes = toolCalls.filter((call) => call.ok === true).length;
		const errors = toolCalls.filter((call) => call.ok === false).length;
		const exposure = toolCalls.length === 0 ? exposures.get(tool) ?? emptyExposure() : calledExposure(toolCalls);
		const candidates = toolCalls.flatMap((call) => call.candidates);
		const toolRepeated = repeated.filter((row) => row.tool === tool && row.cohort_id === cohortId);
		const duration = sum(toolCalls.map((call) => call.duration_ms ?? 0));
		const outputTokens = sum(toolCalls.map((call) => call.output_tokens ?? 0));
		return {
			tool,
			cohort_id: cohortId,
			sessions: new Set(toolCalls.map((call) => call.session_id)).size,
			calls: toolCalls.length,
			successes,
			errors,
			unknown_results: toolCalls.length - successes - errors,
			success_rate: ratio(successes, successes + errors),
			outcome_counts: counts(toolCalls.map((call) => call.outcome)),
			error_code_counts: counts(toolCalls.flatMap((call) => call.error_code ?? [])),
			exposure_turns: exposure.turns,
			unused_exposures: exposure.unused,
			unused_exposure_cost: exposure.unusedTokens,
			definition_tokens: exposure.latestDefinition,
			definition_tokens_per_call: ratio(exposure.tokens, toolCalls.length),
			output_tokens: outputTokens,
			output_tokens_per_call: ratio(outputTokens, toolCalls.length),
			truncated_results: toolCalls.filter((call) => call.output_truncated).length,
			execution_ms: duration,
			execution_ms_per_call: ratio(duration, toolCalls.length),
			accepted_inputs: toolCalls.filter((call) => call.preparation_status === "accepted").length,
			repaired_inputs: toolCalls.filter((call) => call.preparation_status === "repaired").length,
			invalid_inputs: toolCalls.filter((call) => call.preparation_status === "invalid").length,
			repair_counts: counts(toolCalls.flatMap((call) => call.repair_operations)),
			approval_counts: counts(toolCalls.flatMap((call) => call.approval_outcome ?? [])),
			approval_wait_ms: sum(toolCalls.map((call) => call.approval_wait_ms ?? 0)),
			projection_failures: toolCalls.filter((call) => call.projection_failed).length,
			candidates: candidates.length,
			candidates_per_call: ratio(candidates.length, toolCalls.length),
			candidate_group_counts: counts(candidates.map((candidate) => candidate.group)),
			candidate_source_counts: counts(candidates.flatMap((candidate) => candidate.sources)),
			success_duplicates: toolRepeated.filter((row) => row.kind === "success_duplicate").length,
			failure_retries: toolRepeated.filter((row) => row.kind === "failure_retry").length,
			previous_tools: transitionCounts(transitions, "to_tool", "to_cohort_id", tool, cohortId, "from_tool"),
			next_tools: transitionCounts(transitions, "from_tool", "from_cohort_id", tool, cohortId, "to_tool"),
			metric_statistics: metricStatistics(toolCalls),
		};
	});
}

function findRepeatedCalls(calls: readonly CanonicalCall[]): RepeatedCallRow[] {
	const rows: RepeatedCallRow[] = [];
	for (const [sessionId, sessionCalls] of groupBySession(calls)) {
		const latest = new Map<string, CanonicalCall>();
		for (const call of sessionCalls) {
			const previous = latest.get(call.input_key);
			if (previous?.ok !== undefined) {
				rows.push({
					session_id: sessionId,
					previous_call_id: previous.tool_call_id,
					call_id: call.tool_call_id,
					tool: call.tool_name,
					cohort_id: call.cohort_id,
					kind: previous.ok ? "success_duplicate" : "failure_retry",
				});
			}
			latest.set(call.input_key, call);
		}
	}
	return rows.sort((left, right) => compare(left.session_id, right.session_id)
		|| compare(left.previous_call_id, right.previous_call_id)
		|| compare(left.call_id, right.call_id));
}

function metricStatistics(calls: readonly CanonicalCall[]): Record<string, ToolMetricStatistic> {
	const states = new Map<string, MetricState>();
	for (const call of calls) {
		for (const [name, metric] of Object.entries(call.metrics)) {
			const key = metric.unit === undefined ? name : `${name}[${metric.unit}]`;
			const value = metric.value;
			const state = states.get(key) ?? {};
			if (typeof value === "number") {
				const numeric = state.numeric ?? { samples: 0, total: 0, min: value, max: value };
				numeric.samples += 1;
				numeric.total += value;
				numeric.min = Math.min(numeric.min, value);
				numeric.max = Math.max(numeric.max, value);
				state.numeric = numeric;
			} else if (typeof value === "boolean") {
				const booleans = state.booleans ?? { true: 0, false: 0 };
				booleans[value ? "true" : "false"] += 1;
				state.booleans = booleans;
			} else {
				const strings = state.strings ?? new Map<string, number>();
				increment(strings, value);
				state.strings = strings;
			}
			states.set(key, state);
		}
	}
	return Object.fromEntries([...states.entries()].sort(([left], [right]) => compare(left, right)).map(([name, state]) => [name, {
		...(state.numeric === undefined ? {} : { numeric: { ...state.numeric, average: ratio(state.numeric.total, state.numeric.samples) } }),
		...(state.booleans === undefined ? {} : { boolean: state.booleans }),
		...(state.strings === undefined ? {} : { values: sortedObject(state.strings) }),
	}]));
}

function collectExposure(turns: readonly CanonicalTurn[], calls: readonly CanonicalCall[]): Map<string, Exposure> {
	const result = new Map<string, Exposure>();
	const usedByTurn = new Map<string, Set<string>>();
	for (const call of calls) {
		const key = turnKey(call.session_id, call.turn_id);
		const used = usedByTurn.get(key);
		if (used === undefined) usedByTurn.set(key, new Set([call.tool_name]));
		else used.add(call.tool_name);
	}
	for (const turn of turns) {
		const used = usedByTurn.get(turnKey(turn.sessionId, turn.id)) ?? new Set();
		for (const tool of turn.activeTools) {
			const tokens = turn.definitions.get(tool) ?? 0;
			const current = result.get(tool) ?? emptyExposure();
			current.turns += 1;
			current.tokens += tokens;
			current.latestDefinition = tokens;
			if (!used.has(tool)) {
				current.unused += 1;
				current.unusedTokens += tokens;
			}
			result.set(tool, current);
		}
	}
	return result;
}

function transitionCounts(
	rows: readonly ToolTransitionRow[],
	matchKey: "from_tool" | "to_tool",
	cohortKey: "from_cohort_id" | "to_cohort_id",
	tool: string,
	cohortId: string,
	valueKey: "from_tool" | "to_tool",
): Record<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (row[matchKey] === tool && row[cohortKey] === cohortId) counts.set(row[valueKey], row.count);
	}
	return sortedObject(counts);
}

function counts(values: readonly string[]): Record<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) increment(counts, value);
	return sortedObject(counts);
}

function sortedObject(values: Map<string, number>): Record<string, number> {
	return Object.fromEntries([...values.entries()].sort(([left], [right]) => compare(left, right)));
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

function emptyExposure(): Exposure {
	return { turns: 0, unused: 0, tokens: 0, unusedTokens: 0, latestDefinition: 0 };
}

function calledExposure(calls: readonly CanonicalCall[]): Exposure {
	const turns = new Map<string, number>();
	for (const call of calls) turns.set(`${call.session_id}\0${call.turn_id}`, call.definition_tokens);
	const values = [...turns.values()];
	return { turns: turns.size, unused: 0, tokens: sum(values), unusedTokens: 0, latestDefinition: values.at(-1) ?? 0 };
}

function increment(values: Map<string, number>, key: string): void {
	values.set(key, (values.get(key) ?? 0) + 1);
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function turnKey(sessionId: string, turnId: string): string {
	return `${sessionId}\0${turnId}`;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
