import { createHash } from "node:crypto";

import { ingestTelemetryRecords } from "./ingest.js";
import type { CanonicalCall, CanonicalDataset, CanonicalEvent, CanonicalMetric } from "./model.js";
import { canonicalJson } from "./normalize.js";
import { applyAnalysisQuery } from "./query.js";
import type {
	AnalysisQuery,
	CategoricalStatistic,
	CollectionHealthReport,
	Comparability,
	DimensionDistribution,
	MetricStatistic,
	NumericStatistic,
	ReportMetadata,
	ReportSnapshot,
	SliceComparison,
	SliceInventoryRow,
	SliceStatistics,
} from "./types.js";
import { environmentId } from "./types.js";
import { analyzeWorkflow } from "./workflow.js";

const ANALYSIS_COMPONENTS = {
	decoder: "canonical-v3",
	normalization: "path-url-reference-v2",
	slicing: "tool-behavior-instrumentation-v1",
	metrics: "declared-kind-aggregation-v1",
	workflow: "bounded-interaction-branch-region-v1",
	health: "event-ledger-v1",
} as const;

export const ANALYSIS_HASH = createHash("sha256").update(canonicalJson(ANALYSIS_COMPONENTS)).digest("hex");

export interface CalculateTelemetryReportOptions {
	generatedAt?: string;
	scope?: ReportMetadata["scope"];
	consistency?: ReportMetadata["consistency"];
	inputDirectory?: string;
	inputFiles?: string[];
	invalidLines?: number;
	lastCompletedTurn?: number;
	inProgressCalls?: number;
	pendingWrites?: number;
	failedWrites?: number;
	lastWriteFailureAt?: string;
	query?: AnalysisQuery;
}

export function calculateTelemetryReport(records: readonly unknown[], options: CalculateTelemetryReportOptions = {}): ReportSnapshot {
	return buildTelemetryReport(ingestTelemetryRecords(records), records.length, options);
}

/** Durable CLI, HTML and /telemetry share this pure canonical analysis entrypoint. */
export function buildTelemetryReport(dataset: CanonicalDataset, parsedLines: number, options: CalculateTelemetryReportOptions = {}): ReportSnapshot {
	const result = applyAnalysisQuery(dataset, options.query);
	const filteredTurns = dataset.turns.filter((turn) => matchesExposureContext(turn.context, turn.started_at, result.query)
		&& (result.query.tools === undefined || result.query.tools.length === 0 || turn.exposures.some((exposure) => result.query.tools?.includes(exposure.name))));
	const inventory = sliceInventory(result.filtered_calls, dataset, result.query.selected_slice_ids, result.query);
	const callsBySlice = new Map(groupCalls(result.selected_calls).map((calls) => [calls[0]?.slice_id ?? "", calls]));
	const currentSlices = inventory.filter((slice) => result.query.selected_slice_ids.includes(slice.slice_id)).map((slice) => {
		const calls = callsBySlice.get(slice.slice_id);
		return calls === undefined || calls.length === 0 ? emptySliceStatistics(slice) : sliceStatistics(calls);
	});
	const comparison = buildComparison(currentSlices, result.query.baseline_slice_id, result.query.candidate_slice_id);
	const health = collectionHealth(dataset, options);
	const inventorySessionIds = new Set([...result.filtered_calls.map((call) => call.session_id), ...filteredTurns.map((turn) => turn.session_id)]);
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	const metadata: ReportMetadata = {
		schema_version: 1,
		analysis_hash: ANALYSIS_HASH,
		generated_at: generatedAt,
		...(dataset.asOf === undefined ? {} : { as_of: dataset.asOf }),
		scope: options.scope ?? "all_sessions",
		consistency: options.consistency ?? "durable_snapshot",
		...(options.inputDirectory === undefined ? {} : { input_directory: options.inputDirectory }),
		input_files: [...(options.inputFiles ?? [])].sort(compare),
		parsed_lines: parsedLines,
		invalid_lines: options.invalidLines ?? 0,
		...(options.lastCompletedTurn === undefined ? {} : { last_completed_turn: options.lastCompletedTurn }),
		in_progress_calls: options.inProgressCalls ?? 0,
		pending_writes: options.pendingWrites ?? 0,
		failed_writes: options.failedWrites ?? 0,
		...(options.lastWriteFailureAt === undefined ? {} : { last_write_failure_at: options.lastWriteFailureAt }),
		decode_issue_counts: dataset.diagnostics.decode_issue_counts,
	};
	return {
		metadata,
		query: result.query,
		inventory: {
			summary: {
				sessions: inventorySessionIds.size,
				turns: filteredTurns.length,
				calls: result.filtered_calls.length,
				tools: new Set(inventory.map((slice) => slice.tool_name)).size,
				slices: inventory.length,
				complete_sessions: [...inventorySessionIds].filter((sessionId) => dataset.sessionStates.get(sessionId) === "closed").length,
				open_sessions: [...inventorySessionIds].filter((sessionId) => dataset.sessionStates.get(sessionId) !== "closed").length,
				decoded_records: dataset.diagnostics.decoded_records,
				partial_records: dataset.diagnostics.partial_records,
				invalid_records: dataset.diagnostics.invalid_records,
				unknown_events: dataset.diagnostics.unknown_events,
			},
			slices: inventory,
			dimensions: dimensions(result.filtered_calls),
		},
		current_slices: currentSlices,
		...(comparison === undefined ? {} : { comparison }),
		workflow: analyzeWorkflow(result.selected_calls),
		collection_health: health,
		facts: { calls: result.filtered_calls, turns: filteredTurns },
	};
}

function emptySliceStatistics(slice: SliceInventoryRow): SliceStatistics {
	return {
		slice_id: slice.slice_id,
		tool_name: slice.tool_name,
		behavior_hash: slice.behavior_hash,
		instrumentation_hash: slice.instrumentation_hash,
		sessions: slice.sessions,
		calls: 0,
		period: { ...(slice.first_seen === undefined ? {} : { from: slice.first_seen }), ...(slice.last_seen === undefined ? {} : { to: slice.last_seen }) },
		dimensions: slice.dimensions,
		outcomes: { samples: 0, missing: 0, missing_rate: 0, frequencies: {} },
		success_rate: { samples: 0, missing: 0, missing_rate: 0 },
		duration_ms: numericStatistic([], 0),
		output_tokens: numericStatistic([], 0),
		projection_failures: 0,
		metrics: {},
	};
}

function sliceInventory(calls: readonly CanonicalCall[], dataset: CanonicalDataset, selectedSliceIds: readonly string[], query: AnalysisQuery): SliceInventoryRow[] {
	const selected = new Set(selectedSliceIds);
	const groups = new Map<string, { slice: string; calls: CanonicalCall[]; tool: string; behavior: string; instrumentation: string; exposureSessions: Set<string>; exposureTimes: string[]; exposureContexts: NonNullable<CanonicalDataset["turns"][number]["context"]>[] }>();
	for (const sliceCalls of groupCalls(calls)) {
		const first = sliceCalls[0];
		if (first === undefined) continue;
		groups.set(first.slice_id, { slice: first.slice_id, calls: sliceCalls, tool: first.tool_name, behavior: first.identity.behavior_hash, instrumentation: first.identity.instrumentation_hash, exposureSessions: new Set(), exposureTimes: [], exposureContexts: [] });
	}
	for (const turn of dataset.turns) {
		if (!matchesExposureContext(turn.context, turn.started_at, query)) continue;
		for (const exposure of turn.exposures) {
			if (query.tools !== undefined && query.tools.length > 0 && !query.tools.includes(exposure.name)) continue;
			const state = groups.get(exposure.slice_id) ?? { slice: exposure.slice_id, calls: [], tool: exposure.name, behavior: exposure.identity.behavior_hash, instrumentation: exposure.identity.instrumentation_hash, exposureSessions: new Set<string>(), exposureTimes: [], exposureContexts: [] };
			state.exposureSessions.add(turn.session_id);
			if (turn.started_at !== undefined) state.exposureTimes.push(turn.started_at);
			if (turn.context !== undefined) state.exposureContexts.push(turn.context);
			groups.set(exposure.slice_id, state);
		}
	}
	return [...groups.values()].map((state) => {
		const sliceCalls = state.calls;
		const timestamps = sliceCalls.flatMap((call) => call.timing.event_at ?? []).sort(compare);
		timestamps.push(...state.exposureTimes);
		timestamps.sort(compare);
		const firstSeen = timestamps[0];
		const lastSeen = timestamps.at(-1);
		return {
			slice_id: state.slice,
			tool_name: state.tool,
			behavior_hash: state.behavior,
			instrumentation_hash: state.instrumentation,
			...(firstSeen === undefined ? {} : { first_seen: firstSeen }),
			...(lastSeen === undefined ? {} : { last_seen: lastSeen }),
			sessions: new Set([...sliceCalls.map((call) => call.session_id), ...state.exposureSessions]).size,
			calls: sliceCalls.length,
			dimensions: sliceCalls.length > 0 ? dimensions(sliceCalls) : contextDimensions(state.exposureContexts),
			latest_for_tool: selected.has(state.slice),
		};
	}).sort((left, right) => compare(left.tool_name, right.tool_name) || compare(right.last_seen ?? "", left.last_seen ?? "") || compare(left.slice_id, right.slice_id));
}

function matchesExposureContext(context: CanonicalDataset["turns"][number]["context"], timestamp: string | undefined, query: AnalysisQuery): boolean {
	if (context === undefined) return query.collector_contracts === undefined && query.models === undefined && query.thinking_levels === undefined
		&& query.toolset_hashes === undefined && query.projects === undefined && query.environments === undefined;
	const model = context.model === undefined ? "unknown" : `${context.model.provider}/${context.model.id}`;
	return includes(query.collector_contracts, context.collector_contract)
		&& includes(query.models, model)
		&& includes(query.thinking_levels, context.thinking ?? "unknown")
		&& includes(query.toolset_hashes, context.toolset?.hash ?? "unknown")
		&& includes(query.projects, context.project)
		&& includes(query.environments, environmentId(context.environment))
		&& (query.from === undefined || (timestamp !== undefined && timestamp >= query.from))
		&& (query.to === undefined || (timestamp !== undefined && timestamp <= query.to));
}

function contextDimensions(contexts: readonly NonNullable<CanonicalDataset["turns"][number]["context"]>[]): DimensionDistribution {
	return {
		collector_contracts: frequencies(contexts.map((context) => context.collector_contract)),
		models: frequencies(contexts.map((context) => context.model === undefined ? "unknown" : `${context.model.provider}/${context.model.id}`)),
		thinking_levels: frequencies(contexts.map((context) => context.thinking ?? "unknown")),
		toolsets: frequencies(contexts.map((context) => context.toolset?.hash ?? "unknown")),
		projects: frequencies(contexts.map((context) => context.project)),
		environments: frequencies(contexts.map((context) => environmentId(context.environment))),
	};
}

function sliceStatistics(calls: readonly CanonicalCall[]): SliceStatistics {
	const first = calls[0];
	if (first === undefined) throw new Error("empty slice");
	const timestamps = calls.flatMap((call) => call.timing.event_at ?? []).sort(compare);
	const periodFrom = timestamps[0];
	const periodTo = timestamps.at(-1);
	const knownOutcomes = calls.filter((call) => call.outcome !== "unknown");
	const outcomeCounts = frequencies(knownOutcomes.map((call) => call.outcome));
	const outcomeMissing = calls.length - knownOutcomes.length;
	const outcomes: CategoricalStatistic = {
		samples: knownOutcomes.length,
		missing: outcomeMissing,
		missing_rate: ratio(outcomeMissing, calls.length),
		frequencies: outcomeCounts,
	};
	const successSamples = calls.filter((call) => call.ok !== undefined);
	const successes = successSamples.filter((call) => call.ok === true).length;
	return {
		slice_id: first.slice_id,
		tool_name: first.tool_name,
		behavior_hash: first.identity.behavior_hash,
		instrumentation_hash: first.identity.instrumentation_hash,
		sessions: new Set(calls.map((call) => call.session_id)).size,
		calls: calls.length,
		period: {
			...(periodFrom === undefined ? {} : { from: periodFrom }),
			...(periodTo === undefined ? {} : { to: periodTo }),
		},
		dimensions: dimensions(calls),
		outcomes,
		success_rate: {
			...(successSamples.length === 0 ? {} : { value: ratio(successes, successSamples.length) }),
			samples: successSamples.length,
			missing: calls.length - successSamples.length,
			missing_rate: ratio(calls.length - successSamples.length, calls.length),
		},
		duration_ms: numericStatistic(calls.flatMap((call) => call.duration_ms ?? []), calls.length),
		output_tokens: numericStatistic(calls.flatMap((call) => call.output_tokens ?? []), calls.length),
		projection_failures: calls.filter((call) => call.projection_failed === true).length,
		metrics: metricStatistics(calls),
	};
}

function metricStatistics(calls: readonly CanonicalCall[]): Record<string, MetricStatistic> {
	const names = new Set(calls.flatMap((call) => Object.keys(call.metrics)));
	const result: Record<string, MetricStatistic> = {};
	for (const name of [...names].sort(compare)) {
		const metrics = calls.flatMap((call) => call.metrics[name] ?? []);
		const schemas = new Set(metrics.map(metricSchema));
		const first = metrics[0];
		if (first === undefined) continue;
		const missing = calls.length - metrics.length;
		const base = {
			kind: first.kind,
			aggregation: first.aggregation,
			...(first.unit === undefined ? {} : { unit: first.unit }),
			samples: metrics.length,
			missing,
			missing_rate: ratio(missing, calls.length),
		};
		if (schemas.size > 1) {
			result[name] = { ...base, status: "schema_conflict", frequencies: frequencies(metrics.map(metricSchema)) };
			continue;
		}
		if (first.kind === "categorical" || first.aggregation === "count_by_value") {
			result[name] = { ...base, status: "ok", frequencies: frequencies(metrics.map((metric) => String(metric.value))) };
			continue;
		}
		const values = metrics.flatMap((metric) => typeof metric.value === "number" && Number.isFinite(metric.value) ? [metric.value] : []);
		result[name] = values.length === metrics.length
			? { ...base, status: "ok", numeric: numericStatistic(values, calls.length) }
			: { ...base, status: "invalid_value", frequencies: frequencies(metrics.map((metric) => typeof metric.value)) };
	}
	return result;
}

function buildComparison(slices: readonly SliceStatistics[], baselineId: string | undefined, candidateId: string | undefined): SliceComparison | undefined {
	if (baselineId === undefined || candidateId === undefined) return undefined;
	const baseline = slices.find((slice) => slice.slice_id === baselineId);
	const candidate = slices.find((slice) => slice.slice_id === candidateId);
	if (baseline === undefined || candidate === undefined) return undefined;
	return { baseline, candidate, comparability: comparability(baseline, candidate) };
}

function comparability(baseline: SliceStatistics, candidate: SliceStatistics): Comparability {
	const reasons: string[] = [];
	if (baseline.tool_name !== candidate.tool_name) reasons.push("different_tools");
	if (baseline.instrumentation_hash !== candidate.instrumentation_hash) reasons.push("different_instrumentation");
	const environmentDistance = distributionDistance(baseline.dimensions.environments, candidate.dimensions.environments);
	if (environmentDistance > 0.25) reasons.push("material_environment_shift");
	const metricNames = new Set([...Object.keys(baseline.metrics), ...Object.keys(candidate.metrics), "success_rate", "duration_ms", "output_tokens"]);
	const metricFlags: Comparability["metric_flags"] = {};
	for (const name of [...metricNames].sort(compare)) {
		const metricReasons = [...reasons];
		const left = baseline.metrics[name];
		const right = candidate.metrics[name];
		if ((left === undefined) !== (right === undefined)) metricReasons.push("metric_missing_in_one_slice");
		if (left !== undefined && right !== undefined && metricSchema(left) !== metricSchema(right)) metricReasons.push("metric_schema_changed");
		const leftSamples = comparisonSamples(baseline, name);
		const rightSamples = comparisonSamples(candidate, name);
		if (leftSamples < 5 || rightSamples < 5) metricReasons.push("insufficient_samples");
		metricFlags[name] = { comparable: metricReasons.length === 0, reasons: metricReasons };
	}
	return { comparable: reasons.length === 0, reasons, environment_distance: environmentDistance, metric_flags: metricFlags };
}

function comparisonSamples(slice: SliceStatistics, name: string): number {
	if (name === "success_rate") return slice.success_rate.samples;
	if (name === "duration_ms") return slice.duration_ms.samples;
	if (name === "output_tokens") return slice.output_tokens.samples;
	return slice.metrics[name]?.samples ?? 0;
}

function collectionHealth(dataset: CanonicalDataset, options: CalculateTelemetryReportOptions): CollectionHealthReport {
	const sequences = sequenceHealth(dataset.events);
	const starts = new Set(dataset.events.filter((event) => event.event === "tool_call_start" && event.tool_call_id !== undefined).map((event) => `${event.session_id}\0${event.tool_call_id}`));
	const ends = new Set(dataset.events.filter((event) => event.event === "tool_call_end" && event.tool_call_id !== undefined).map((event) => `${event.session_id}\0${event.tool_call_id}`));
	const pairedMissingStarts = [...ends].filter((id) => !starts.has(id)).length;
	const pairedMissingEnds = [...starts].filter((id) => !ends.has(id)).length;
	const mismatches = dataset.turns.filter((turn) => turn.expected_call_count !== undefined && (
		turn.expected_call_count !== turn.observed_start_count || turn.expected_call_count !== turn.observed_end_count)).length;
	const observedIssues = new Map<string, number>();
	for (const issue of dataset.collectionIssues) observedIssues.set(issue.issue, (observedIssues.get(issue.issue) ?? 0) + issue.count);
	const missingStarts = Math.max(pairedMissingStarts, dataset.turns.reduce((sum, turn) => sum + turn.missing_start_ids.length, 0), observedIssues.get("missing_start") ?? 0);
	const missingEnds = Math.max(pairedMissingEnds, dataset.turns.reduce((sum, turn) => sum + turn.missing_end_ids.length, 0), observedIssues.get("missing_end") ?? 0);
	const unfinishedTurns = Math.max(dataset.turns.filter((turn) => turn.started_at !== undefined && turn.ended_at === undefined).length, observedIssues.get("unfinished_turn") ?? 0);
	const writerFailures = (observedIssues.get("writer_failure") ?? 0) + (options.failedWrites ?? 0);
	const projectionFailures = Math.max(observedIssues.get("projection_failed") ?? 0, dataset.calls.filter((call) => call.projection_failed === true).length);
	const counts = {
		sequence_gaps: Math.max(sequences.gaps, observedIssues.get("sequence_gap") ?? 0),
		duplicate_events: dataset.diagnostics.duplicate_records,
		duplicate_sequences: sequences.duplicates,
		out_of_order_events: sequences.outOfOrder,
		missing_starts: missingStarts,
		missing_ends: missingEnds,
		unfinished_turns: unfinishedTurns,
		call_count_mismatches: mismatches,
		projection_failures: projectionFailures,
		writer_failures: writerFailures,
		invalid_lines: options.invalidLines ?? 0,
		invalid_records: dataset.diagnostics.invalid_records,
		partial_records: dataset.diagnostics.partial_records,
		unknown_events: dataset.diagnostics.unknown_events,
	};
	const warnings = Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => `${name}:${count}`);
	for (const [issue, count] of observedIssues) if (count > 0) warnings.push(`observed_${issue}:${count}`);
	const critical = counts.writer_failures + counts.missing_ends + counts.sequence_gaps + counts.call_count_mismatches + (observedIssues.get("invalid_jsonl") ?? 0) > 0;
	return { status: critical ? "critical" : warnings.length > 0 ? "warning" : "healthy", warnings: [...new Set(warnings)].sort(compare), counts, observed_issues: sortedObject(observedIssues) };
}

function sequenceHealth(events: readonly CanonicalEvent[]): { gaps: number; duplicates: number; outOfOrder: number } {
	const bySession = new Map<string, number[]>();
	const orderedBySession = new Map<string, number[]>();
	for (const event of events) {
		if (event.sequence === undefined) continue;
		const values = bySession.get(event.session_id);
		if (values === undefined) bySession.set(event.session_id, [event.sequence]);
		else values.push(event.sequence);
		// Health sidecars are read separately from the main ledger, so their file order is not event order.
		if (event.event !== "collection_health") {
			const ordered = orderedBySession.get(event.session_id);
			if (ordered === undefined) orderedBySession.set(event.session_id, [event.sequence]);
			else ordered.push(event.sequence);
		}
	}
	let gaps = 0;
	let duplicates = 0;
	let outOfOrder = 0;
	for (const values of orderedBySession.values()) {
		for (let index = 1; index < values.length; index += 1) {
			const previous = values[index - 1];
			const current = values[index];
			if (previous !== undefined && current !== undefined && current < previous) outOfOrder += 1;
		}
	}
	for (const values of bySession.values()) {
		const unique = [...new Set(values)].sort((left, right) => left - right);
		duplicates += values.length - unique.length;
		for (let index = 1; index < unique.length; index += 1) {
			const previous = unique[index - 1];
			const current = unique[index];
			if (previous !== undefined && current !== undefined && current > previous + 1) gaps += current - previous - 1;
		}
	}
	return { gaps, duplicates, outOfOrder };
}

function dimensions(calls: readonly CanonicalCall[]): DimensionDistribution {
	return {
		collector_contracts: frequencies(calls.map((call) => call.context.collector_contract)),
		models: frequencies(calls.map((call) => call.context.model === undefined ? "unknown" : `${call.context.model.provider}/${call.context.model.id}`)),
		thinking_levels: frequencies(calls.map((call) => call.context.thinking ?? "unknown")),
		toolsets: frequencies(calls.map((call) => call.context.toolset?.hash ?? "unknown")),
		projects: frequencies(calls.map((call) => call.context.project)),
		environments: frequencies(calls.map((call) => environmentId(call.context.environment))),
	};
}

function groupCalls(calls: readonly CanonicalCall[]): CanonicalCall[][] {
	const groups = new Map<string, CanonicalCall[]>();
	for (const call of calls) {
		const values = groups.get(call.slice_id);
		if (values === undefined) groups.set(call.slice_id, [call]);
		else values.push(call);
	}
	return [...groups.values()].sort((left, right) => compare(left[0]?.slice_id ?? "", right[0]?.slice_id ?? ""));
}

function numericStatistic(values: readonly number[], totalSamples: number): NumericStatistic {
	const sorted = [...values].sort((left, right) => left - right);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	const missing = Math.max(0, totalSamples - sorted.length);
	return {
		samples: sorted.length,
		missing,
		missing_rate: ratio(missing, totalSamples),
		total: rounded(total),
		min: sorted[0] ?? 0,
		max: sorted.at(-1) ?? 0,
		mean: ratio(total, sorted.length),
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
	};
}

function percentile(values: readonly number[], percentileValue: number): number {
	if (values.length === 0) return 0;
	const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentileValue) - 1));
	return values[index] ?? 0;
}

function distributionDistance(left: Record<string, number>, right: Record<string, number>): number {
	const leftTotal = Object.values(left).reduce((sum, value) => sum + value, 0);
	const rightTotal = Object.values(right).reduce((sum, value) => sum + value, 0);
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	let distance = 0;
	for (const key of keys) distance += Math.abs(ratio(left[key] ?? 0, leftTotal) - ratio(right[key] ?? 0, rightTotal));
	return rounded(distance / 2);
}

function metricSchema(metric: CanonicalMetric | MetricStatistic): string {
	return `${metric.kind}\0${metric.aggregation}\0${metric.unit ?? ""}`;
}

function frequencies(values: readonly string[]): Record<string, number> {
	const result = new Map<string, number>();
	for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
	return sortedObject(result);
}

function includes(values: readonly string[] | undefined, value: string): boolean {
	return values === undefined || values.length === 0 || values.includes(value);
}

function sortedObject(values: ReadonlyMap<string, number>): Record<string, number> {
	return Object.fromEntries([...values].sort(([left], [right]) => compare(left, right)));
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
