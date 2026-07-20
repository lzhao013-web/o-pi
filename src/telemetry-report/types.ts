import type { CanonicalCall, CanonicalEnvironment, CanonicalTurn } from "./model.js";

export interface AnalysisQuery {
	tools?: string[];
	slice_ids?: string[];
	config_hashes?: string[];
	latest?: boolean;
	collector_contracts?: string[];
	models?: string[];
	thinking_levels?: string[];
	toolset_hashes?: string[];
	workload_hashes?: string[];
	workload_shapes?: string[];
	repo_map_enabled?: string[];
	repo_map_freshnesses?: string[];
	repo_map_identities?: string[];
	projects?: string[];
	environments?: string[];
	from?: string;
	to?: string;
	baseline_slice_id?: string;
	candidate_slice_id?: string;
}

export interface ResolvedAnalysisQuery extends AnalysisQuery {
	latest: boolean;
	selected_slice_ids: string[];
}

export interface DimensionDistribution {
	collector_contracts: Record<string, number>;
	models: Record<string, number>;
	thinking_levels: Record<string, number>;
	toolsets: Record<string, number>;
	workloads: Record<string, number>;
	workload_identities: Record<string, number>;
	projects: Record<string, number>;
	environments: Record<string, number>;
	repo_map_enabled: Record<string, number>;
	repo_map_freshness: Record<string, number>;
	repo_map_identities: Record<string, number>;
}

export interface SliceInventoryRow {
	slice_id: string;
	tool_name: string;
	behavior_hash: string;
	instrumentation_hash: string;
	config_hash: string;
	first_seen?: string;
	last_seen?: string;
	sessions: number;
	calls: number;
	dimensions: DimensionDistribution;
	latest_for_tool: boolean;
}

export interface NumericStatistic {
	samples: number;
	missing: number;
	missing_rate: number;
	total?: number;
	min?: number;
	max?: number;
	mean?: number;
	p50?: number;
	p95?: number;
	median_confidence_interval?: { low: number; high: number };
}

export interface RateStatistic {
	numerator: number;
	samples: number;
	missing: number;
	missing_rate: number;
	value?: number;
	wilson_interval?: { low: number; high: number };
}

export interface TokenStatistic extends NumericStatistic {
	methods: Record<string, { samples: number; total: number }>;
	mixed_methods: boolean;
}

export interface CategoricalStatistic {
	samples: number;
	missing: number;
	missing_rate: number;
	frequencies: Record<string, number>;
}

export interface MetricStatistic {
	kind: string;
	aggregation: string;
	unit?: string;
	samples: number;
	missing: number;
	missing_rate: number;
	status: "ok" | "schema_conflict" | "invalid_value";
	frequencies?: Record<string, number>;
	numeric?: NumericStatistic;
}

export interface SliceStatistics {
	slice_id: string;
	tool_name: string;
	behavior_hash: string;
	instrumentation_hash: string;
	config_hash: string;
	sessions: number;
	calls: number;
	period: { from?: string; to?: string };
	dimensions: DimensionDistribution;
	outcomes: CategoricalStatistic;
	execution_success_rate: RateStatistic;
	duration_ms: NumericStatistic;
	start_to_execute_ms: NumericStatistic;
	execution_duration_ms: NumericStatistic;
	approval_wait_ms: NumericStatistic;
	output_tokens: TokenStatistic;
	exposed_turns: number;
	selected_turns: number;
	selected_calls: number;
	selected_turn_rate: RateStatistic;
	calls_per_exposed_turn?: number;
	definition_token_cost: TokenStatistic;
	unused_definition_token_cost: TokenStatistic;
	validation_failure_rate: RateStatistic;
	repair_rate: RateStatistic;
	repair_operations: Record<string, number>;
	requested_executed_difference_rate: RateStatistic;
	approval_observation_rate: RateStatistic;
	approval_ask_rate: RateStatistic;
	user_approval_allow_rate: RateStatistic;
	block_rate: RateStatistic;
	unfinished_rate: RateStatistic;
	unfinished_before_execute: number;
	unfinished_during_execute: number;
	truncation_rate: RateStatistic;
	error_codes: Record<string, number>;
	batch_call_rate: RateStatistic;
	parallel_execution_rate: RateStatistic;
	repo_map: { enabled: Record<string, number>; freshness: Record<string, number>; identities: Record<string, number> };
	usefulness: { heuristic: true; signals: { produced_candidates: number; candidate_conversion_attributions: number; repeated_calls: number; fallbacks: number } };
	projection_failures: number;
	projection_limits: number;
	metrics: Record<string, MetricStatistic>;
	observations: {
		attributes: Record<string, CategoricalStatistic>;
		measurements: Record<string, NumericStatistic & { unit?: string; status: "ok" | "unit_conflict" }>;
		stages: Record<string, { calls: number; occurrences: number; statuses: CategoricalStatistic; duration_ms: NumericStatistic; measurements: Record<string, NumericStatistic & { unit?: string; status: "ok" | "unit_conflict" }> }>;
	};
}

export interface Comparability {
	comparable: boolean;
	reasons: string[];
	environment_distance: number;
	dimension_distances: Record<string, number>;
	metric_flags: Record<string, { comparable: boolean; reasons: string[]; baseline_samples: number; candidate_samples: number; baseline_missing_rate: number; candidate_missing_rate: number; effect?: { kind: string; value: number; confidence_interval?: { low: number; high: number } } }>;
}

export interface SliceComparison {
	baseline: SliceStatistics;
	candidate: SliceStatistics;
	comparability: Comparability;
}

export interface WorkflowEvidence {
	heuristic: true;
	confidence: "strong" | "moderate" | "weak";
	reasons: string[];
}

export interface ToolTransitionRow {
	from_slice_id: string;
	from_tool: string;
	to_slice_id: string;
	to_tool: string;
	count: number;
	sessions: number;
	same_target: number;
	evidence: WorkflowEvidence;
}

export interface RepeatedCallRow {
	session_id: string;
	previous_call_id: string;
	call_id: string;
	slice_id: string;
	tool: string;
	kind: "success_duplicate" | "failure_retry";
	evidence: WorkflowEvidence;
}

export interface CandidateConversionRow {
	producer_slice_id: string;
	producer_tool: string;
	source: string;
	group: string;
	candidates: number;
	strong_conversions: number;
	weak_conversions: number;
	strong_conversion_rate: number;
	weak_conversion_rate: number;
	exposed_sessions: number;
	converted_sessions: number;
	consumer_counts: Record<string, number>;
	evidence: WorkflowEvidence;
}

export type FailureRecoveryKind = "exact_retry" | "modified_retry" | "fallback" | "unrecovered";

export interface FailureRecoveryRow {
	session_id: string;
	failed_call_id: string;
	failed_tool: string;
	failure_outcome: string;
	kind: FailureRecoveryKind;
	recovery_call_id?: string;
	recovery_tool?: string;
	calls_to_recovery?: number;
	evidence: WorkflowEvidence;
}

export interface NearRetryRow {
	session_id: string;
	previous_call_id: string;
	call_id: string;
	tool: string;
	changed_fields: string[];
	evidence: WorkflowEvidence;
}

export interface ToolOscillationRow {
	session_id: string;
	first_call_id: string;
	middle_call_id: string;
	last_call_id: string;
	pattern: string;
	evidence: WorkflowEvidence;
}

export interface WorkflowReport {
	heuristic: true;
	method: string;
	transitions: ToolTransitionRow[];
	repeated_calls: RepeatedCallRow[];
	candidate_conversions: CandidateConversionRow[];
	failure_recoveries: FailureRecoveryRow[];
	near_retries: NearRetryRow[];
	tool_oscillations: ToolOscillationRow[];
	excluded: Record<string, number>;
}

export interface CollectionHealthReport {
	status: "healthy" | "warning" | "critical";
	warnings: string[];
	counts: {
		sequence_gaps: number;
		duplicate_events: number;
		duplicate_sequences: number;
		out_of_order_events: number;
		missing_starts: number;
		missing_ends: number;
		unfinished_turns: number;
		call_count_mismatches: number;
		projection_failures: number;
		projection_limits: number;
		writer_failures: number;
		dropped_writes: number;
		omitted_live_records: number;
		manifest_failures: number;
		runtime_event_drops: number;
		invalid_lines: number;
		invalid_records: number;
		partial_records: number;
		unknown_events: number;
	};
	observed_issues: Record<string, number>;
}

export interface InventorySummary {
	sessions: number;
	turns: number;
	calls: number;
	tools: number;
	slices: number;
	complete_sessions: number;
	open_sessions: number;
	decoded_records: number;
	partial_records: number;
	invalid_records: number;
	unknown_events: number;
}

export interface ReportMetadata {
	analysis_hash: string;
	generated_at: string;
	as_of?: string;
	scope: "all_sessions" | "current_session";
	consistency: "durable_snapshot" | "live_observed";
	input_directory?: string;
	input_files: string[];
	parsed_lines: number;
	invalid_lines: number;
	last_completed_turn?: number;
	in_progress_calls: number;
	pending_writes: number;
	failed_writes: number;
	dropped_writes: number;
	omitted_live_records: number;
	last_write_failure_at?: string;
	decode_issue_counts: Record<string, number>;
}

export interface ReportSnapshot {
	metadata: ReportMetadata;
	query: ResolvedAnalysisQuery;
	inventory: { summary: InventorySummary; slices: SliceInventoryRow[]; dimensions: DimensionDistribution };
	current_slices: SliceStatistics[];
	comparison?: SliceComparison;
	workflow: WorkflowReport;
	collection_health: CollectionHealthReport;
	facts: { calls: CanonicalCall[]; turns: CanonicalTurn[] };
}

export function environmentId(environment: CanonicalEnvironment): string {
	const values = [environment.platform, environment.arch, environment.mode, environment.pi_version, environment.node_version]
		.map((value) => value ?? "unknown");
	return values.join("/");
}
