import type { CanonicalCall, CanonicalEnvironment, CanonicalTurn } from "./model.js";

export interface AnalysisQuery {
	tools?: string[];
	slice_ids?: string[];
	latest?: boolean;
	collector_contracts?: string[];
	models?: string[];
	thinking_levels?: string[];
	toolset_hashes?: string[];
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
	projects: Record<string, number>;
	environments: Record<string, number>;
}

export interface SliceInventoryRow {
	slice_id: string;
	tool_name: string;
	behavior_hash: string;
	instrumentation_hash: string;
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
	total: number;
	min: number;
	max: number;
	mean: number;
	p50: number;
	p95: number;
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
	sessions: number;
	calls: number;
	period: { from?: string; to?: string };
	dimensions: DimensionDistribution;
	outcomes: CategoricalStatistic;
	success_rate: { value?: number; samples: number; missing: number; missing_rate: number };
	duration_ms: NumericStatistic;
	output_tokens: NumericStatistic;
	projection_failures: number;
	metrics: Record<string, MetricStatistic>;
}

export interface Comparability {
	comparable: boolean;
	reasons: string[];
	environment_distance: number;
	metric_flags: Record<string, { comparable: boolean; reasons: string[] }>;
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
		writer_failures: number;
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
	schema_version: 1;
	analysis_hash: string;
	generated_at: string;
	as_of?: string;
	scope: "all_sessions" | "current_session";
	consistency: "durable_snapshot" | "live_committed";
	input_directory?: string;
	input_files: string[];
	parsed_lines: number;
	invalid_lines: number;
	last_completed_turn?: number;
	in_progress_calls: number;
	pending_writes: number;
	failed_writes: number;
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
