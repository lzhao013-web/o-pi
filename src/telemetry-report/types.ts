export interface ToolReportRow {
	tool: string;
	cohort_id: string;
	sessions: number;
	calls: number;
	successes: number;
	errors: number;
	unknown_results: number;
	success_rate: number;
	outcome_counts: Record<string, number>;
	error_code_counts: Record<string, number>;
	exposure_turns: number;
	unused_exposures: number;
	unused_exposure_cost: number;
	definition_tokens: number;
	definition_tokens_per_call: number;
	output_tokens: number;
	output_tokens_per_call: number;
	truncated_results: number;
	execution_ms: number;
	execution_ms_per_call: number;
	accepted_inputs: number;
	repaired_inputs: number;
	invalid_inputs: number;
	repair_counts: Record<string, number>;
	approval_counts: Record<string, number>;
	approval_wait_ms: number;
	projection_failures: number;
	candidates: number;
	candidates_per_call: number;
	candidate_group_counts: Record<string, number>;
	candidate_source_counts: Record<string, number>;
	success_duplicates: number;
	failure_retries: number;
	previous_tools: Record<string, number>;
	next_tools: Record<string, number>;
	metric_statistics: Record<string, ToolMetricStatistic>;
}

export interface ToolMetricStatistic {
	numeric?: { samples: number; total: number; min: number; max: number; average: number };
	boolean?: { true: number; false: number };
	values?: Record<string, number>;
}

export interface ToolTransitionRow {
	from_tool: string;
	from_cohort_id: string;
	to_tool: string;
	to_cohort_id: string;
	count: number;
	sessions: number;
	probability: number;
	lift: number;
	same_turn: number;
	cross_turn: number;
	same_target: number;
	from_outcome_counts: Record<string, number>;
	to_outcome_counts: Record<string, number>;
}

export interface RepeatedCallRow {
	session_id: string;
	previous_call_id: string;
	call_id: string;
	tool: string;
	cohort_id: string;
	kind: "success_duplicate" | "failure_retry";
}

export interface CandidateConversionRow {
	producer_tool: string;
	producer_cohort_id: string;
	source: string;
	group: string;
	candidates: number;
	converted: number;
	conversion_rate: number;
	exposed_sessions: number;
	converted_sessions: number;
	top_1_candidates: number;
	top_1_converted: number;
	top_1_conversion_rate: number;
	top_3_candidates: number;
	top_3_converted: number;
	top_3_conversion_rate: number;
	average_converted_rank: number;
	average_calls_to_use: number;
	consumer_counts: Record<string, number>;
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
	recovery_execution_ms: number;
	recovery_output_tokens: number;
}

export interface NearRetryRow {
	session_id: string;
	previous_call_id: string;
	call_id: string;
	tool: string;
	previous_outcome: string;
	outcome: string;
	changed_fields: string[];
}

export interface ToolOscillationRow {
	session_id: string;
	first_call_id: string;
	middle_call_id: string;
	last_call_id: string;
	pattern: string;
	same_turn: boolean;
	same_target: boolean;
	outcomes: string[];
}

export interface ReportSummary {
	sessions: number;
	turns: number;
	tools: number;
	calls: number;
	successes: number;
	errors: number;
	unknown_results: number;
	success_rate: number;
	repeated_calls: number;
	failure_retries: number;
	near_retries: number;
	tool_oscillations: number;
	candidate_exposures: number;
	candidate_conversions: number;
	candidate_conversion_rate: number;
	failed_calls: number;
	recovered_failures: number;
	failure_recovery_rate: number;
	exact_recoveries: number;
	modified_recoveries: number;
	fallback_recoveries: number;
	unrecovered_failures: number;
	output_tokens: number;
	execution_ms: number;
}

export interface ReportMetadata {
	generated_at: string;
	as_of: string;
	scope: "all_sessions" | "current_session";
	consistency: "durable_snapshot" | "live_committed";
	input_directory?: string;
	input_files: string[];
	complete_sessions: number;
	open_sessions: number;
	last_completed_turn?: number;
	in_progress_calls: number;
	pending_writes: number;
	failed_writes: number;
	last_write_failure_at?: string;
	parsed_lines: number;
	decoded_records: number;
	partial_records: number;
	unknown_events: number;
	invalid_records: number;
	duplicate_records: number;
	invalid_lines: number;
}

export interface ReportSnapshot {
	tools: ToolReportRow[];
	tool_transitions: ToolTransitionRow[];
	repeated_calls: RepeatedCallRow[];
	candidate_conversions: CandidateConversionRow[];
	failure_recoveries: FailureRecoveryRow[];
	near_retries: NearRetryRow[];
	tool_oscillations: ToolOscillationRow[];
	summary: ReportSummary;
	metadata: ReportMetadata;
}
