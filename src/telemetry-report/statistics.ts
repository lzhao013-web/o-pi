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
	RateStatistic,
	ReportMetadata,
	ReportSnapshot,
	SliceComparison,
	SliceInventoryRow,
	SliceStatistics,
	TokenStatistic,
	WorkflowReport,
} from "./types.js";
import { environmentId } from "./types.js";
import { analyzeWorkflow } from "./workflow.js";
import { createManifest } from "../telemetry/manifest.js";
import { sourceBundleDescriptor } from "../telemetry/source-identity.js";

export const ANALYSIS_MANIFEST = createManifest("analysis_contract", {
	identity: ["tool_name", "behavior_hash", "instrumentation_hash", "config_hash"],
	canonical_lifecycle: ["session_id", "run_id", "tool_call_id", "phase", "terminal_status"],
	implementation: sourceBundleDescriptor(["src/telemetry-report/statistics.ts"]),
});
export const ANALYSIS_HASH = ANALYSIS_MANIFEST.hash;

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
	droppedWrites?: number;
	omittedLiveRecords?: number;
	lastWriteFailureAt?: string;
	query?: AnalysisQuery;
}

export function calculateTelemetryReport(records: readonly unknown[], options: CalculateTelemetryReportOptions = {}): ReportSnapshot {
	return buildTelemetryReport(ingestTelemetryRecords(records), records.length, options);
}

/** Durable CLI, HTML and /telemetry share this pure canonical analysis entrypoint. */
export function buildTelemetryReport(dataset: CanonicalDataset, parsedLines: number, options: CalculateTelemetryReportOptions = {}): ReportSnapshot {
	const result = applyAnalysisQuery(dataset, options.query);
	const filteredTurns = dataset.turns.filter((turn) => matchesExposureContext(turn.context, turn.started_at, result.query, turn.repo_map)
		&& (result.query.tools === undefined || result.query.tools.length === 0 || turn.exposures.some((exposure) => result.query.tools?.includes(exposure.name))));
	const inventory = sliceInventory(result.filtered_calls, dataset, result.query.selected_slice_ids, result.query);
	const workflow = analyzeWorkflow(result.selected_calls);
	const callsBySlice = new Map(groupCalls(result.selected_calls).map((calls) => [calls[0]?.slice_id ?? "", calls]));
	const currentSlices = inventory.filter((slice) => result.query.selected_slice_ids.includes(slice.slice_id)).map((slice) => {
		const calls = callsBySlice.get(slice.slice_id);
		return calls === undefined || calls.length === 0 ? emptySliceStatistics(slice, filteredTurns) : sliceStatistics(calls, filteredTurns, result.selected_calls, workflow);
	});
	const comparison = buildComparison(currentSlices, callsBySlice, result.query.baseline_slice_id, result.query.candidate_slice_id);
	const health = collectionHealth(dataset, options);
	const inventorySessionIds = new Set([...result.filtered_calls.map((call) => call.session_id), ...filteredTurns.map((turn) => turn.session_id)]);
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	const metadata: ReportMetadata = {
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
		dropped_writes: options.droppedWrites ?? 0,
		omitted_live_records: options.omittedLiveRecords ?? 0,
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
		workflow,
		collection_health: health,
		facts: { calls: result.filtered_calls, turns: filteredTurns },
	};
}

function emptySliceStatistics(slice: SliceInventoryRow, turns: readonly CanonicalDataset["turns"][number][]): SliceStatistics {
	const exposure = exposureFacts(slice.slice_id, [], turns);
	return {
		slice_id: slice.slice_id,
		tool_name: slice.tool_name,
		behavior_hash: slice.behavior_hash,
		instrumentation_hash: slice.instrumentation_hash,
		config_hash: slice.config_hash,
		sessions: slice.sessions,
		calls: 0,
		period: { ...(slice.first_seen === undefined ? {} : { from: slice.first_seen }), ...(slice.last_seen === undefined ? {} : { to: slice.last_seen }) },
		dimensions: slice.dimensions,
		outcomes: { samples: 0, missing: 0, missing_rate: 0, frequencies: {} },
		execution_success_rate: rateStatistic(0, 0, 0),
		duration_ms: numericStatistic([], 0),
		start_to_execute_ms: numericStatistic([], 0),
		execution_duration_ms: numericStatistic([], 0),
		approval_wait_ms: numericStatistic([], 0),
		output_tokens: tokenStatistic([], 0),
		...exposure,
		validation_failure_rate: rateStatistic(0, 0, 0), repair_rate: rateStatistic(0, 0, 0), repair_operations: {},
		requested_executed_difference_rate: rateStatistic(0, 0, 0), approval_observation_rate: rateStatistic(0, 0, 0),
		approval_ask_rate: rateStatistic(0, 0, 0), user_approval_allow_rate: rateStatistic(0, 0, 0), block_rate: rateStatistic(0, 0, 0),
		unfinished_rate: rateStatistic(0, 0, 0), unfinished_before_execute: 0, unfinished_during_execute: 0,
		truncation_rate: rateStatistic(0, 0, 0), batch_call_rate: rateStatistic(0, 0, 0), parallel_execution_rate: rateStatistic(0, 0, 0),
		error_codes: {},
		usefulness: { heuristic: true, signals: { produced_candidates: 0, candidate_conversion_attributions: 0, repeated_calls: 0, fallbacks: 0 } },
		projection_failures: 0,
		projection_limits: 0,
		metrics: {},
		observations: { attributes: {}, measurements: {}, stages: {} },
	};
}

function sliceInventory(calls: readonly CanonicalCall[], dataset: CanonicalDataset, selectedSliceIds: readonly string[], query: AnalysisQuery): SliceInventoryRow[] {
	const selected = new Set(selectedSliceIds);
	const groups = new Map<string, { slice: string; calls: CanonicalCall[]; tool: string; behavior: string; instrumentation: string; config: string; exposureSessions: Set<string>; exposureTimes: string[]; exposureContexts: NonNullable<CanonicalDataset["turns"][number]["context"]>[] }>();
	for (const sliceCalls of groupCalls(calls)) {
		const first = sliceCalls[0];
		if (first === undefined) continue;
		groups.set(first.slice_id, { slice: first.slice_id, calls: sliceCalls, tool: first.tool_name, behavior: first.identity.behavior_hash, instrumentation: first.identity.instrumentation_hash, config: first.identity.config_hash, exposureSessions: new Set(), exposureTimes: [], exposureContexts: [] });
	}
	for (const turn of dataset.turns) {
		if (!matchesExposureContext(turn.context, turn.started_at, query, turn.repo_map)) continue;
		for (const exposure of turn.exposures) {
			if (query.tools !== undefined && query.tools.length > 0 && !query.tools.includes(exposure.name)) continue;
			if (!includes(query.config_hashes, exposure.identity.config_hash)) continue;
			const state = groups.get(exposure.slice_id) ?? { slice: exposure.slice_id, calls: [], tool: exposure.name, behavior: exposure.identity.behavior_hash, instrumentation: exposure.identity.instrumentation_hash, config: exposure.identity.config_hash, exposureSessions: new Set<string>(), exposureTimes: [], exposureContexts: [] };
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
			config_hash: state.config,
			...(firstSeen === undefined ? {} : { first_seen: firstSeen }),
			...(lastSeen === undefined ? {} : { last_seen: lastSeen }),
			sessions: new Set([...sliceCalls.map((call) => call.session_id), ...state.exposureSessions]).size,
			calls: sliceCalls.length,
			dimensions: sliceCalls.length > 0 ? dimensions(sliceCalls) : contextDimensions(state.exposureContexts),
			latest_for_tool: selected.has(state.slice),
		};
	}).sort((left, right) => compare(left.tool_name, right.tool_name) || compare(right.last_seen ?? "", left.last_seen ?? "") || compare(left.slice_id, right.slice_id));
}

function matchesExposureContext(
	context: CanonicalDataset["turns"][number]["context"],
	timestamp: string | undefined,
	query: AnalysisQuery,
	repoMap: CanonicalDataset["turns"][number]["repo_map"],
): boolean {
	if (context === undefined) return query.collector_contracts === undefined && query.models === undefined && query.thinking_levels === undefined
		&& query.toolset_hashes === undefined && query.workload_hashes === undefined && query.workload_shapes === undefined
		&& query.repo_map_enabled === undefined && query.repo_map_freshnesses === undefined && query.repo_map_identities === undefined
		&& query.projects === undefined && query.environments === undefined;
	const model = context.model === undefined ? "unknown" : `${context.model.provider}/${context.model.id}`;
	return includes(query.collector_contracts, context.collector_contract_hash)
		&& includes(query.models, model)
		&& includes(query.thinking_levels, context.thinking ?? "unknown")
		&& includes(query.toolset_hashes, context.toolset?.hash ?? "unknown")
		&& includes(query.workload_hashes, context.workload?.prompt_hash ?? "unknown")
		&& includes(query.workload_shapes, context.workload?.shape ?? "unknown")
		&& includes(query.repo_map_enabled, String(repoMap.enabled))
		&& includes(query.repo_map_freshnesses, repoMap.freshness ?? "unknown")
		&& includes(query.repo_map_identities, repoMap.map_id ?? "unknown")
		&& includes(query.projects, context.project)
		&& includes(query.environments, environmentId(context.environment))
		&& (query.from === undefined || (timestamp !== undefined && timestamp >= query.from))
		&& (query.to === undefined || (timestamp !== undefined && timestamp <= query.to));
}

function contextDimensions(contexts: readonly NonNullable<CanonicalDataset["turns"][number]["context"]>[]): DimensionDistribution {
	return {
		collector_contracts: frequencies(contexts.map((context) => context.collector_contract_hash)),
		models: frequencies(contexts.map((context) => context.model === undefined ? "unknown" : `${context.model.provider}/${context.model.id}`)),
		thinking_levels: frequencies(contexts.map((context) => context.thinking ?? "unknown")),
		toolsets: frequencies(contexts.map((context) => context.toolset?.hash ?? "unknown")),
		workloads: frequencies(contexts.map((context) => context.workload?.shape ?? "unknown")),
		workload_identities: frequencies(contexts.map((context) => context.workload?.prompt_hash ?? "unknown")),
		projects: frequencies(contexts.map((context) => context.project)),
		environments: frequencies(contexts.map((context) => environmentId(context.environment))),
		repo_map_enabled: frequencies(contexts.map((context) => String(context.repo_map?.enabled ?? false))),
		repo_map_freshness: frequencies(contexts.map((context) => context.repo_map?.freshness ?? "unknown")),
		repo_map_identities: frequencies(contexts.map((context) => context.repo_map?.map_id ?? "unknown")),
	};
}

function sliceStatistics(
	calls: readonly CanonicalCall[],
	turns: readonly CanonicalDataset["turns"][number][],
	allCalls: readonly CanonicalCall[],
	workflow: WorkflowReport,
): SliceStatistics {
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
	const executed = calls.filter((call) => call.executed_input !== undefined);
	const approvalObserved = calls.filter((call) => call.approval_outcome !== undefined);
	const approvalAsked = calls.filter((call) => call.approval_decision === "ask");
	const approvalAllowed = approvalAsked.filter((call) => ["allow_once", "allow_session", "allow_persistent"].includes(call.approval_outcome ?? ""));
	const truncationObserved = calls.filter((call) => call.output_truncated !== undefined);
	const parallel = parallelCallIds(allCalls);
	const callIds = new Set(calls.map((call) => call.tool_call_id));
	return {
		slice_id: first.slice_id,
		tool_name: first.tool_name,
		behavior_hash: first.identity.behavior_hash,
		instrumentation_hash: first.identity.instrumentation_hash,
		config_hash: first.identity.config_hash,
		sessions: new Set(calls.map((call) => call.session_id)).size,
		calls: calls.length,
		period: {
			...(periodFrom === undefined ? {} : { from: periodFrom }),
			...(periodTo === undefined ? {} : { to: periodTo }),
		},
		dimensions: dimensions(calls),
		outcomes,
		execution_success_rate: rateStatistic(successes, successSamples.length, calls.length),
		duration_ms: numericStatistic(calls.flatMap((call) => call.duration_ms ?? []), calls.length),
		start_to_execute_ms: numericStatistic(calls.flatMap((call) => durationBetween(call.timing.call_started_at, call.timing.execution_started_at)), calls.length),
		execution_duration_ms: numericStatistic(calls.flatMap((call) => call.timing.execution_duration_ms ?? []), calls.length),
		approval_wait_ms: numericStatistic(calls.flatMap((call) => call.approval_wait_ms ?? []), calls.length),
		output_tokens: tokenStatistic(calls.flatMap((call) => call.output_tokens ?? []), calls.length),
		...exposureFacts(first.slice_id, calls, turns),
		validation_failure_rate: rateStatistic(calls.filter((call) => call.terminal_status === "validation_failed").length, calls.length, calls.length),
		repair_rate: rateStatistic(calls.filter((call) => call.preparation_status === "repaired").length, calls.length, calls.length),
		repair_operations: frequencies(calls.flatMap((call) => call.repair_operations)),
		requested_executed_difference_rate: rateStatistic(calls.filter((call) => call.executed_input !== undefined
			&& canonicalJson({ value: call.requested_input, references: call.requested_references })
				!== canonicalJson({ value: call.executed_input, references: call.executed_references ?? [] })).length,
			executed.length, calls.length),
		approval_observation_rate: rateStatistic(approvalObserved.length, calls.length, calls.length),
		approval_ask_rate: rateStatistic(approvalAsked.length, approvalObserved.length, calls.length),
		user_approval_allow_rate: rateStatistic(approvalAllowed.length, approvalAsked.length, approvalAsked.length),
		block_rate: rateStatistic(calls.filter((call) => call.terminal_status === "blocked").length, calls.length, calls.length),
		unfinished_rate: rateStatistic(calls.filter((call) => call.terminal_status === "unfinished").length, calls.length, calls.length),
		unfinished_before_execute: calls.filter((call) => call.terminal_status === "unfinished" && call.phase === "declared").length,
		unfinished_during_execute: calls.filter((call) => call.terminal_status === "unfinished" && call.phase === "executing").length,
		truncation_rate: rateStatistic(truncationObserved.filter((call) => call.output_truncated === true).length, truncationObserved.length, calls.length),
		error_codes: frequencies(calls.flatMap((call) => call.error_code ?? [])),
		batch_call_rate: rateStatistic(calls.filter((call) => (call.context.tool_batch?.size ?? 0) > 1).length, calls.length, calls.length),
		parallel_execution_rate: rateStatistic(calls.filter((call) => parallel.has(callKey(call))).length, calls.length, calls.length),
		usefulness: { heuristic: true, signals: {
			produced_candidates: calls.reduce((sum, call) => sum + call.candidates.length, 0),
			candidate_conversion_attributions: workflow.candidate_conversions.filter((row) => row.producer_slice_id === first.slice_id)
				.reduce((sum, row) => sum + row.strong_conversions + row.weak_conversions, 0),
			repeated_calls: workflow.repeated_calls.filter((row) => row.slice_id === first.slice_id).length,
			fallbacks: workflow.failure_recoveries.filter((row) => row.kind === "fallback" && callIds.has(row.failed_call_id)).length,
		} },
		projection_failures: calls.filter((call) => call.projection_failed === true).length,
		projection_limits: calls.filter((call) => call.projection_limited === true).length,
		metrics: metricStatistics(calls),
		observations: observationStatistics(calls),
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

function observationStatistics(calls: readonly CanonicalCall[]): SliceStatistics["observations"] {
	const attributeValues = new Map<string, string[]>();
	for (const call of calls) {
		if (call.attributes === undefined) continue;
		for (const [path, value] of flattenScalars(call.attributes)) {
			const values = attributeValues.get(path);
			if (values === undefined) attributeValues.set(path, [String(value)]);
			else values.push(String(value));
		}
	}
	const attributes = Object.fromEntries([...attributeValues].sort(([left], [right]) => compare(left, right)).map(([path, values]) => [path, {
		samples: values.length,
		missing: Math.max(0, calls.length - values.length),
		missing_rate: ratio(Math.max(0, calls.length - values.length), calls.length),
		frequencies: frequencies(values),
	}]));
	const measurements = measurementStatistics(calls.flatMap((call) => call.measurements), calls.length);
	const stageNames = new Set(calls.flatMap((call) => call.stages.map((stage) => stage.name)));
	const stages: SliceStatistics["observations"]["stages"] = {};
	for (const name of [...stageNames].sort(compare)) {
		const matchingCalls = calls.filter((call) => call.stages.some((stage) => stage.name === name));
		const occurrences = calls.flatMap((call) => call.stages.filter((stage) => stage.name === name));
		const statuses = occurrences.flatMap((stage) => stage.status ?? []);
		stages[name] = {
			calls: matchingCalls.length,
			occurrences: occurrences.length,
			statuses: { samples: statuses.length, missing: occurrences.length - statuses.length,
				missing_rate: ratio(occurrences.length - statuses.length, occurrences.length), frequencies: frequencies(statuses) },
			duration_ms: numericStatistic(occurrences.flatMap((stage) => stage.duration_ms ?? []), occurrences.length),
			measurements: measurementStatistics(occurrences.flatMap((stage) => stage.measurements), occurrences.length),
		};
	}
	return { attributes, measurements, stages };
}

function measurementStatistics(
	measurements: readonly { name: string; value: number; unit?: string }[],
	totalSamples: number,
): SliceStatistics["observations"]["measurements"] {
	const grouped = new Map<string, Array<{ value: number; unit?: string }>>();
	for (const measurement of measurements) {
		const values = grouped.get(measurement.name);
		const item = { value: measurement.value, ...(measurement.unit === undefined ? {} : { unit: measurement.unit }) };
		if (values === undefined) grouped.set(measurement.name, [item]);
		else values.push(item);
	}
	const result: SliceStatistics["observations"]["measurements"] = {};
	for (const [name, values] of [...grouped].sort(([left], [right]) => compare(left, right))) {
		const units = new Set(values.map((value) => value.unit ?? ""));
		const unit = values[0]?.unit;
		result[name] = {
			...numericStatistic(values.map((value) => value.value), totalSamples),
			...(unit === undefined ? {} : { unit }),
			status: units.size > 1 ? "unit_conflict" : "ok",
		};
	}
	return result;
}

function flattenScalars(value: Record<string, unknown>, prefix = ""): Array<[string, string | number | boolean | null]> {
	const result: Array<[string, string | number | boolean | null]> = [];
	for (const [key, child] of Object.entries(value)) {
		const path = prefix.length === 0 ? key : `${prefix}.${key}`;
		if (child === null || typeof child === "string" || typeof child === "boolean" || (typeof child === "number" && Number.isFinite(child))) result.push([path, child]);
		else if (typeof child === "object" && child !== null && !Array.isArray(child)) result.push(...flattenScalars(child as Record<string, unknown>, path));
	}
	return result;
}

function buildComparison(
	slices: readonly SliceStatistics[],
	callsBySlice: ReadonlyMap<string, readonly CanonicalCall[]>,
	baselineId: string | undefined,
	candidateId: string | undefined,
): SliceComparison | undefined {
	if (baselineId === undefined || candidateId === undefined) return undefined;
	const baseline = slices.find((slice) => slice.slice_id === baselineId);
	const candidate = slices.find((slice) => slice.slice_id === candidateId);
	if (baseline === undefined || candidate === undefined) return undefined;
	return { baseline, candidate, comparability: comparability(baseline, candidate, callsBySlice.get(baselineId) ?? [], callsBySlice.get(candidateId) ?? []) };
}

function comparability(
	baseline: SliceStatistics,
	candidate: SliceStatistics,
	baselineCalls: readonly CanonicalCall[],
	candidateCalls: readonly CanonicalCall[],
): Comparability {
	const reasons: string[] = [];
	if (baseline.tool_name !== candidate.tool_name) reasons.push("different_tools");
	if (baseline.instrumentation_hash !== candidate.instrumentation_hash) reasons.push("different_instrumentation");
	if (baseline.config_hash !== candidate.config_hash) reasons.push("different_config");
	const distributions = {
		collector_contract: [baseline.dimensions.collector_contracts, candidate.dimensions.collector_contracts],
		config: [{ [baseline.config_hash]: baseline.calls }, { [candidate.config_hash]: candidate.calls }],
		model: [baseline.dimensions.models, candidate.dimensions.models],
		thinking_level: [baseline.dimensions.thinking_levels, candidate.dimensions.thinking_levels],
		toolset: [baseline.dimensions.toolsets, candidate.dimensions.toolsets],
		workload_shape: [baseline.dimensions.workloads, candidate.dimensions.workloads],
		workload_identity: [baseline.dimensions.workload_identities, candidate.dimensions.workload_identities],
		project: [baseline.dimensions.projects, candidate.dimensions.projects],
		environment: [baseline.dimensions.environments, candidate.dimensions.environments],
	} satisfies Record<string, [Record<string, number>, Record<string, number>]>;
	const dimensionDistances = Object.fromEntries(Object.entries(distributions).map(([name, values]) => [name, distributionDistance(values[0], values[1])])) as Record<string, number>;
	for (const [dimension, distance] of Object.entries(dimensionDistances)) if (distance > 0.25) reasons.push(`material_${dimension}_shift`);
	const environmentDistance = dimensionDistances["environment"] ?? 0;
	const metricNames = new Set([
		...Object.keys(baseline.metrics), ...Object.keys(candidate.metrics),
		"execution_success_rate", "duration_ms", "start_to_execute_ms", "execution_duration_ms", "approval_wait_ms", "output_tokens",
		"definition_token_cost", "unused_definition_token_cost",
		"selected_turn_rate", "validation_failure_rate", "repair_rate", "requested_executed_difference_rate", "approval_ask_rate",
		"user_approval_allow_rate", "block_rate", "unfinished_rate", "truncation_rate", "batch_call_rate", "parallel_execution_rate",
		...Object.keys(baseline.observations.measurements).map((name) => `measurement:${name}`),
		...Object.keys(candidate.observations.measurements).map((name) => `measurement:${name}`),
	]);
	const metricFlags: Comparability["metric_flags"] = {};
	for (const name of [...metricNames].sort(compare)) {
		const metricReasons = [...reasons];
		const left = baseline.metrics[name];
		const right = candidate.metrics[name];
		if (!isBuiltInMetric(name) && !name.startsWith("measurement:")) {
			if ((left === undefined) !== (right === undefined)) metricReasons.push("metric_missing_in_one_slice");
			if (left !== undefined && right !== undefined && metricSchema(left) !== metricSchema(right)) metricReasons.push("metric_schema_changed");
		}
		if (name.startsWith("measurement:")) {
			const measurement = name.slice("measurement:".length);
			const leftMeasurement = baseline.observations.measurements[measurement];
			const rightMeasurement = candidate.observations.measurements[measurement];
			if ((leftMeasurement === undefined) !== (rightMeasurement === undefined)) metricReasons.push("metric_missing_in_one_slice");
			if (leftMeasurement !== undefined && rightMeasurement !== undefined
				&& (leftMeasurement.unit !== rightMeasurement.unit || leftMeasurement.status !== "ok" || rightMeasurement.status !== "ok")) metricReasons.push("metric_schema_changed");
		}
		if (["output_tokens", "definition_token_cost", "unused_definition_token_cost"].includes(name)) {
			const leftMethods = numericForComparison(baseline, name);
			const rightMethods = numericForComparison(candidate, name);
			if (isTokenStatistic(leftMethods) && isTokenStatistic(rightMethods)
				&& canonicalJson(leftMethods.methods) !== canonicalJson(rightMethods.methods)) metricReasons.push("token_estimator_mix_changed");
		}
		const leftSamples = comparisonSamples(baseline, name);
		const rightSamples = comparisonSamples(candidate, name);
		const leftMissing = comparisonMissingRate(baseline, name);
		const rightMissing = comparisonMissingRate(candidate, name);
		if (Math.max(leftMissing, rightMissing) > 0.3 || Math.abs(leftMissing - rightMissing) > 0.15) metricReasons.push("material_missingness");
		if (!enoughSamples(name, leftSamples, rightSamples)) metricReasons.push("insufficient_samples_for_metric");
		if (new Set(baselineCalls.map((call) => call.session_id)).size < 5
			|| new Set(candidateCalls.map((call) => call.session_id)).size < 5) metricReasons.push("insufficient_independent_sessions");
		const uniqueReasons = [...new Set(metricReasons)];
		const effect = uniqueReasons.length === 0 ? comparisonEffect(name, baseline, candidate, baselineCalls, candidateCalls) : undefined;
		metricFlags[name] = { comparable: uniqueReasons.length === 0, reasons: uniqueReasons, baseline_samples: leftSamples,
			candidate_samples: rightSamples, baseline_missing_rate: leftMissing, candidate_missing_rate: rightMissing,
			...(effect === undefined ? {} : { effect }) };
	}
	const finalReasons = [...new Set(reasons)];
	if (finalReasons.length === 0 && !Object.values(metricFlags).some((flag) => flag.comparable)) finalReasons.push("no_comparable_metrics");
	return { comparable: finalReasons.length === 0, reasons: finalReasons, environment_distance: environmentDistance, dimension_distances: dimensionDistances, metric_flags: metricFlags };
}

function comparisonSamples(slice: SliceStatistics, name: string): number {
	const rate = rateForComparison(slice, name);
	if (rate !== undefined) return rate.samples;
	const numeric = numericForComparison(slice, name);
	if (numeric !== undefined) return numeric.samples;
	if (name.startsWith("measurement:")) return slice.observations.measurements[name.slice("measurement:".length)]?.samples ?? 0;
	return slice.metrics[name]?.samples ?? 0;
}

function comparisonMissingRate(slice: SliceStatistics, name: string): number {
	const rate = rateForComparison(slice, name);
	if (rate !== undefined) return rate.missing_rate;
	const numeric = numericForComparison(slice, name);
	if (numeric !== undefined) return numeric.missing_rate;
	if (name.startsWith("measurement:")) return slice.observations.measurements[name.slice("measurement:".length)]?.missing_rate ?? 1;
	return slice.metrics[name]?.missing_rate ?? 1;
}

function enoughSamples(name: string, left: number, right: number): boolean {
	return rateName(name) ? left >= 20 && right >= 20 : left >= 12 && right >= 12;
}

function comparisonEffect(
	name: string,
	baseline: SliceStatistics,
	candidate: SliceStatistics,
	baselineCalls: readonly CanonicalCall[],
	candidateCalls: readonly CanonicalCall[],
): Comparability["metric_flags"][string]["effect"] {
	const leftRate = rateForComparison(baseline, name);
	const rightRate = rateForComparison(candidate, name);
	if (leftRate?.value !== undefined && rightRate?.value !== undefined) {
		const interval = name === "execution_success_rate"
			? clusterBootstrapDifference(baselineCalls, candidateCalls, (call) => call.ok === undefined ? undefined : Number(call.ok), mean)
			: undefined;
		return { kind: "rate_difference", value: rounded(rightRate.value - leftRate.value), ...(interval === undefined ? {} : { confidence_interval: interval }) };
	}
	const leftNumeric = numericForComparison(baseline, name) ?? (name.startsWith("measurement:") ? baseline.observations.measurements[name.slice("measurement:".length)] : undefined);
	const rightNumeric = numericForComparison(candidate, name) ?? (name.startsWith("measurement:") ? candidate.observations.measurements[name.slice("measurement:".length)] : undefined);
	if (leftNumeric?.p50 !== undefined && rightNumeric?.p50 !== undefined) {
		const interval = clusterBootstrapDifference(baselineCalls, candidateCalls, (call) => numericCallValue(call, name), median);
		return { kind: "median_difference", value: rounded(rightNumeric.p50 - leftNumeric.p50), ...(interval === undefined ? {} : { confidence_interval: interval }) };
	}
	return undefined;
}

function numericCallValue(call: CanonicalCall, name: string): number | undefined {
	switch (name) {
		case "duration_ms": return call.duration_ms;
		case "start_to_execute_ms": return durationBetween(call.timing.call_started_at, call.timing.execution_started_at)[0];
		case "execution_duration_ms": return call.timing.execution_duration_ms;
		case "approval_wait_ms": return call.approval_wait_ms;
		case "output_tokens": return call.output_tokens?.value;
		case "definition_token_cost": return undefined;
		case "unused_definition_token_cost": return undefined;
		default: {
			if (name.startsWith("measurement:")) {
				const measurement = call.measurements.find((item) => item.name === name.slice("measurement:".length));
				return measurement?.value;
			}
			const metric = call.metrics[name];
			return typeof metric?.value === "number" ? metric.value : undefined;
		}
	}
}

const RATE_METRICS = new Set([
	"execution_success_rate", "selected_turn_rate", "validation_failure_rate", "repair_rate",
	"requested_executed_difference_rate", "approval_observation_rate", "approval_ask_rate",
	"user_approval_allow_rate", "block_rate", "unfinished_rate", "truncation_rate",
	"batch_call_rate", "parallel_execution_rate",
]);

const NUMERIC_METRICS = new Set([
	"duration_ms", "start_to_execute_ms", "execution_duration_ms", "approval_wait_ms", "output_tokens",
	"definition_token_cost", "unused_definition_token_cost",
]);

function isBuiltInMetric(name: string): boolean {
	return RATE_METRICS.has(name) || NUMERIC_METRICS.has(name);
}

function rateName(name: string): boolean {
	return RATE_METRICS.has(name);
}

function rateForComparison(slice: SliceStatistics, name: string): RateStatistic | undefined {
	switch (name) {
		case "execution_success_rate": return slice.execution_success_rate;
		case "selected_turn_rate": return slice.selected_turn_rate;
		case "validation_failure_rate": return slice.validation_failure_rate;
		case "repair_rate": return slice.repair_rate;
		case "requested_executed_difference_rate": return slice.requested_executed_difference_rate;
		case "approval_observation_rate": return slice.approval_observation_rate;
		case "approval_ask_rate": return slice.approval_ask_rate;
		case "user_approval_allow_rate": return slice.user_approval_allow_rate;
		case "block_rate": return slice.block_rate;
		case "unfinished_rate": return slice.unfinished_rate;
		case "truncation_rate": return slice.truncation_rate;
		case "batch_call_rate": return slice.batch_call_rate;
		case "parallel_execution_rate": return slice.parallel_execution_rate;
		default: return undefined;
	}
}

function numericForComparison(slice: SliceStatistics, name: string): NumericStatistic | undefined {
	switch (name) {
		case "duration_ms": return slice.duration_ms;
		case "start_to_execute_ms": return slice.start_to_execute_ms;
		case "execution_duration_ms": return slice.execution_duration_ms;
		case "approval_wait_ms": return slice.approval_wait_ms;
		case "output_tokens": return slice.output_tokens;
		case "definition_token_cost": return slice.definition_token_cost;
		case "unused_definition_token_cost": return slice.unused_definition_token_cost;
		default: return slice.metrics[name]?.numeric;
	}
}

function isTokenStatistic(value: NumericStatistic | undefined): value is TokenStatistic {
	return value !== undefined && "methods" in value;
}

function clusterBootstrapDifference(
	baselineCalls: readonly CanonicalCall[],
	candidateCalls: readonly CanonicalCall[],
	read: (call: CanonicalCall) => number | undefined,
	estimator: (values: readonly number[]) => number | undefined,
): { low: number; high: number } | undefined {
	const baseline = sessionValues(baselineCalls, read);
	const candidate = sessionValues(candidateCalls, read);
	if (baseline.length < 2 || candidate.length < 2) return undefined;
	const random = pseudoRandom([...baselineCalls, ...candidateCalls].map(callKey).sort(compare).join("\0"));
	const effects: number[] = [];
	for (let iteration = 0; iteration < 1_000; iteration += 1) {
		const left = estimator(resampleClusters(baseline, random));
		const right = estimator(resampleClusters(candidate, random));
		if (left !== undefined && right !== undefined) effects.push(right - left);
	}
	if (effects.length === 0) return undefined;
	effects.sort((left, right) => left - right);
	return {
		low: rounded(percentile(effects, 0.025) ?? effects[0] ?? 0),
		high: rounded(percentile(effects, 0.975) ?? effects.at(-1) ?? 0),
	};
}

function sessionValues(calls: readonly CanonicalCall[], read: (call: CanonicalCall) => number | undefined): number[][] {
	const grouped = new Map<string, number[]>();
	for (const call of calls) {
		const value = read(call);
		if (value === undefined || !Number.isFinite(value)) continue;
		const values = grouped.get(call.session_id);
		if (values === undefined) grouped.set(call.session_id, [value]);
		else values.push(value);
	}
	return [...grouped].sort(([left], [right]) => compare(left, right)).map(([, values]) => values);
}

function resampleClusters(clusters: readonly number[][], random: () => number): number[] {
	const result: number[] = [];
	for (let index = 0; index < clusters.length; index += 1) {
		const selected = clusters[Math.floor(random() * clusters.length)];
		if (selected !== undefined) result.push(...selected);
	}
	return result;
}

function pseudoRandom(seed: string): () => number {
	let state = 2_166_136_261;
	for (let index = 0; index < seed.length; index += 1) state = Math.imul(state ^ seed.charCodeAt(index), 16_777_619) >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ value >>> 15, value | 1);
		value ^= value + Math.imul(value ^ value >>> 7, value | 61);
		return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
	};
}

function mean(values: readonly number[]): number | undefined {
	return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const right = sorted[middle];
	if (right === undefined) return undefined;
	const left = sorted[middle - 1];
	return sorted.length % 2 === 0 && left !== undefined ? (left + right) / 2 : right;
}

function collectionHealth(dataset: CanonicalDataset, options: CalculateTelemetryReportOptions): CollectionHealthReport {
	const sequences = sequenceHealth(dataset.events);
	const starts = new Set(dataset.events.filter((event) => event.event === "tool_call_start" && event.tool_call_id !== undefined).map(eventCallKey));
	const ends = new Set(dataset.events.filter((event) => event.event === "tool_call_end" && event.tool_call_id !== undefined).map(eventCallKey));
	const liveTruncated = (options.omittedLiveRecords ?? 0) > 0;
	const pairedMissingStarts = liveTruncated ? 0 : [...ends].filter((id) => !starts.has(id)).length;
	const pairedMissingEnds = liveTruncated ? 0 : [...starts].filter((id) => !ends.has(id)).length;
	const mismatches = dataset.turns.filter((turn) => turn.expected_call_count !== undefined && (
		turn.expected_call_count !== turn.observed_start_count || turn.expected_call_count !== turn.observed_end_count)).length;
	const observedIssues = new Map<string, number>();
	for (const issue of dataset.collectionIssues) observedIssues.set(issue.issue, (observedIssues.get(issue.issue) ?? 0) + issue.count);
	const missingStarts = Math.max(pairedMissingStarts, dataset.turns.reduce((sum, turn) => sum + turn.missing_start_ids.length, 0), observedIssues.get("missing_start") ?? 0);
	const missingEnds = Math.max(pairedMissingEnds, dataset.turns.reduce((sum, turn) => sum + turn.missing_end_ids.length, 0), observedIssues.get("missing_end") ?? 0);
	const unfinishedTurns = Math.max(dataset.turns.filter((turn) => turn.started_at !== undefined && turn.ended_at === undefined).length, observedIssues.get("unfinished_turn") ?? 0);
	const writerFailures = (observedIssues.get("writer_failure") ?? 0) + (options.failedWrites ?? 0);
	const projectionFailures = Math.max(observedIssues.get("projection_failed") ?? 0, dataset.calls.filter((call) => call.projection_failed === true).length);
	const projectionLimits = Math.max(observedIssues.get("projection_limited") ?? 0, dataset.calls.filter((call) => call.projection_limited === true).length);
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
		projection_limits: projectionLimits,
		writer_failures: writerFailures,
		dropped_writes: options.droppedWrites ?? 0,
		omitted_live_records: options.omittedLiveRecords ?? 0,
		manifest_failures: observedIssues.get("manifest_write_failure") ?? 0,
		runtime_event_drops: observedIssues.get("runtime_event_drop") ?? 0,
		invalid_lines: options.invalidLines ?? 0,
		invalid_records: dataset.diagnostics.invalid_records,
		partial_records: dataset.diagnostics.partial_records,
		unknown_events: dataset.diagnostics.unknown_events,
	};
	const warnings = Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => `${name}:${count}`);
	for (const [issue, count] of observedIssues) if (count > 0) warnings.push(`observed_${issue}:${count}`);
	const critical = counts.writer_failures + counts.dropped_writes + counts.manifest_failures + counts.missing_ends
		+ counts.sequence_gaps + counts.call_count_mismatches + (observedIssues.get("invalid_jsonl") ?? 0) > 0;
	return { status: critical ? "critical" : warnings.length > 0 ? "warning" : "healthy", warnings: [...new Set(warnings)].sort(compare), counts, observed_issues: sortedObject(observedIssues) };
}

function eventCallKey(event: CanonicalEvent): string {
	return `${event.session_id}\0${event.run_id ?? event.id}\0${event.tool_call_id ?? ""}`;
}

function sequenceHealth(events: readonly CanonicalEvent[]): { gaps: number; duplicates: number; outOfOrder: number } {
	const bySession = new Map<string, number[]>();
	const orderedBySession = new Map<string, number[]>();
	for (const event of events) {
		if (event.sequence === undefined) continue;
		const stream = `${event.session_id}\0${event.run_id ?? event.id}\0${event.stream_id ?? "legacy"}`;
		const values = bySession.get(stream);
		if (values === undefined) bySession.set(stream, [event.sequence]);
		else values.push(event.sequence);
		// Health sidecars are read separately from the main ledger, so their file order is not event order.
		if (event.event !== "collection_health") {
			const ordered = orderedBySession.get(stream);
			if (ordered === undefined) orderedBySession.set(stream, [event.sequence]);
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
		collector_contracts: frequencies(calls.map((call) => call.context.collector_contract_hash)),
		models: frequencies(calls.map((call) => call.context.model === undefined ? "unknown" : `${call.context.model.provider}/${call.context.model.id}`)),
		thinking_levels: frequencies(calls.map((call) => call.context.thinking ?? "unknown")),
		toolsets: frequencies(calls.map((call) => call.context.toolset?.hash ?? "unknown")),
		workloads: frequencies(calls.map((call) => call.context.workload?.shape ?? "unknown")),
		workload_identities: frequencies(calls.map((call) => call.context.workload?.prompt_hash ?? "unknown")),
		projects: frequencies(calls.map((call) => call.context.project)),
		environments: frequencies(calls.map((call) => environmentId(call.context.environment))),
		repo_map_enabled: frequencies(calls.map((call) => String(call.context.repo_map?.enabled ?? false))),
		repo_map_freshness: frequencies(calls.map((call) => call.context.repo_map?.freshness ?? "unknown")),
		repo_map_identities: frequencies(calls.map((call) => call.context.repo_map?.map_id ?? "unknown")),
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

function callKey(call: CanonicalCall): string {
	return `${call.session_id}\0${call.run_id}\0${call.tool_call_id}`;
}

function parallelCallIds(calls: readonly CanonicalCall[]): Set<string> {
	const result = new Set<string>();
	const groups = new Map<string, CanonicalCall[]>();
	for (const call of calls) {
		const key = `${call.session_id}\0${call.turn_id}`;
		const values = groups.get(key);
		if (values === undefined) groups.set(key, [call]);
		else values.push(call);
	}
	for (const values of groups.values()) {
		for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
			const left = values[leftIndex];
			if (left === undefined) continue;
			const leftStart = Date.parse(left.timing.execution_started_at ?? "");
			const leftEnd = Date.parse(left.timing.execution_ended_at ?? "");
			if (!Number.isFinite(leftStart) || !Number.isFinite(leftEnd)) continue;
			for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
				const right = values[rightIndex];
				if (right === undefined) continue;
				const rightStart = Date.parse(right.timing.execution_started_at ?? "");
				const rightEnd = Date.parse(right.timing.execution_ended_at ?? "");
				if (!Number.isFinite(rightStart) || !Number.isFinite(rightEnd)) continue;
				if (leftStart < rightEnd && rightStart < leftEnd) {
					result.add(callKey(left));
					result.add(callKey(right));
				}
			}
		}
	}
	return result;
}

function numericStatistic(values: readonly number[], totalSamples: number): NumericStatistic {
	const sorted = [...values].sort((left, right) => left - right);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	const missing = Math.max(0, totalSamples - sorted.length);
	const first = sorted[0];
	const last = sorted.at(-1);
	return {
		samples: sorted.length,
		missing,
		missing_rate: ratio(missing, totalSamples),
		...(first === undefined || last === undefined ? {} : { total: rounded(total), min: first, max: last, mean: ratio(total, sorted.length), p50: percentile(sorted, 0.5) ?? first, p95: percentile(sorted, 0.95) ?? last, median_confidence_interval: medianConfidenceInterval(sorted, first, last) }),
	};
}

function percentile(values: readonly number[], percentileValue: number): number | undefined {
	if (values.length === 0) return undefined;
	const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentileValue) - 1));
	return values[index] ?? 0;
}

function medianConfidenceInterval(values: readonly number[], first: number, last: number): { low: number; high: number } {
	const radius = 0.98 * Math.sqrt(values.length);
	const lowIndex = Math.max(0, Math.floor(values.length / 2 - radius));
	const highIndex = Math.min(values.length - 1, Math.ceil(values.length / 2 + radius));
	return { low: values[lowIndex] ?? first, high: values[highIndex] ?? last };
}

function exposureFacts(sliceId: string, calls: readonly CanonicalCall[], turns: readonly CanonicalDataset["turns"][number][]) {
	const exposed = turns.filter((turn) => turn.exposures.some((item) => item.slice_id === sliceId));
	const definitionTokens = exposed.flatMap((turn) => turn.exposures.find((item) => item.slice_id === sliceId)?.definition_tokens ?? []);
	const calledTurns = new Set(calls.map((call) => `${call.session_id}\0${call.turn_id}`));
	const exposedKeys = new Set(exposed.map((turn) => `${turn.session_id}\0${turn.id}`));
	const selectedTurns = [...calledTurns].filter((key) => exposedKeys.has(key)).length;
	const unusedExposures = exposed.filter((turn) => !calledTurns.has(`${turn.session_id}\0${turn.id}`));
	const unusedDefinitionTokens = unusedExposures.flatMap((turn) => turn.exposures.find((item) => item.slice_id === sliceId)?.definition_tokens ?? []);
	return {
		exposed_turns: exposed.length,
		selected_turns: selectedTurns,
		selected_calls: calls.length,
		selected_turn_rate: rateStatistic(selectedTurns, exposed.length, exposed.length),
		...(exposed.length === 0 ? {} : { calls_per_exposed_turn: ratio(calls.length, exposed.length) }),
		definition_token_cost: tokenStatistic(definitionTokens, exposed.length),
		unused_definition_token_cost: tokenStatistic(unusedDefinitionTokens, unusedExposures.length),
		repo_map: {
			enabled: frequencies(exposed.map((turn) => String(turn.repo_map.enabled))),
			freshness: frequencies(exposed.map((turn) => turn.repo_map.freshness ?? "unknown")),
			identities: frequencies(exposed.map((turn) => turn.repo_map.map_id ?? "unknown")),
		},
	};
}

function durationBetween(start: string | undefined, end: string | undefined): number[] {
	if (start === undefined || end === undefined) return [];
	const value = Date.parse(end) - Date.parse(start);
	return Number.isFinite(value) && value >= 0 ? [value] : [];
}

function rateStatistic(numerator: number, samples: number, totalSamples: number): RateStatistic {
	const boundedSamples = Math.max(0, samples);
	const boundedNumerator = Math.min(Math.max(0, numerator), boundedSamples);
	const missing = Math.max(0, totalSamples - boundedSamples);
	return {
		numerator: boundedNumerator,
		samples: boundedSamples,
		missing,
		missing_rate: ratio(missing, totalSamples),
		...(boundedSamples === 0 ? {} : {
			value: ratio(boundedNumerator, boundedSamples),
			wilson_interval: wilsonInterval(boundedNumerator, boundedSamples),
		}),
	};
}

function tokenStatistic(values: readonly CanonicalCall["output_tokens"][], totalSamples: number): TokenStatistic {
	const estimates = values.filter((value): value is NonNullable<CanonicalCall["output_tokens"]> => value !== undefined);
	const methods = new Map<string, { samples: number; total: number }>();
	for (const estimate of estimates) {
		const current = methods.get(estimate.method) ?? { samples: 0, total: 0 };
		methods.set(estimate.method, { samples: current.samples + 1, total: current.total + estimate.value });
	}
	return {
		...numericStatistic(estimates.map((estimate) => estimate.value), totalSamples),
		methods: Object.fromEntries([...methods].sort(([left], [right]) => compare(left, right))),
		mixed_methods: methods.size > 1,
	};
}

function wilsonInterval(successes: number, samples: number): { low: number; high: number } {
	const z = 1.959963984540054;
	const probability = successes / samples;
	const denominator = 1 + z * z / samples;
	const center = (probability + z * z / (2 * samples)) / denominator;
	const margin = z * Math.sqrt((probability * (1 - probability) + z * z / (4 * samples)) / samples) / denominator;
	return { low: rounded(Math.max(0, center - margin)), high: rounded(Math.min(1, center + margin)) };
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
	for (const value of values) {
		const key = value === "__telemetry_other__" ? "__telemetry_value:__telemetry_other__" : value;
		result.set(key, (result.get(key) ?? 0) + 1);
	}
	if (result.size <= 256) return sortedObject(result);
	const retained = [...result].sort((left, right) => right[1] - left[1] || compare(left[0], right[0])).slice(0, 255);
	const retainedKeys = new Set(retained.map(([key]) => key));
	const omitted = [...result].filter(([key]) => !retainedKeys.has(key)).reduce((sum, [, count]) => sum + count, 0);
	return sortedObject(new Map([...retained, ["__telemetry_other__", omitted]]));
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
