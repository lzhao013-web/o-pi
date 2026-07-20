export interface CanonicalSource {
	id: string;
	family?: string;
	rank?: number;
}

export interface CanonicalResource {
	content_hash?: { algorithm: string; value: string };
	snapshot?: string;
	revision?: string;
	start_line?: number;
	end_line?: number;
}

export interface CanonicalReference {
	relation: string;
	kind: string;
	value: string;
	global_rank?: number;
	group_rank?: number;
	group?: string;
	sources: CanonicalSource[];
	resource?: CanonicalResource;
}

export interface CanonicalCandidate extends CanonicalReference {
	relation: "candidate";
	global_rank: number;
	group: string;
}

export interface CanonicalMetric {
	value: string | number | boolean;
	kind: string;
	aggregation: string;
	unit?: string;
}

export interface CanonicalEnvironment {
	pi_version?: string;
	mode?: string;
	platform?: string;
	arch?: string;
	node_version?: string;
}

export interface CanonicalContext {
	collector_contract: string;
	model?: { provider: string; id: string };
	thinking?: string;
	toolset?: { active: string[]; hash: string };
	project: string;
	environment: CanonicalEnvironment;
	interaction?: string;
	branch?: { leaf_id?: string; lineage_hash: string; depth?: number };
	assistant_message?: string;
	tool_batch?: { id: string; size?: number; index?: number };
}

export interface CanonicalTiming {
	event_at?: string;
	call_started_at?: string;
	execution_started_at?: string;
	execution_ended_at?: string;
	call_duration_ms?: number;
	execution_duration_ms?: number;
}

export interface ToolIdentityDimensions {
	behavior_hash: string;
	instrumentation_hash: string;
	definition_hash: string;
	config_hash: string;
}

export interface CanonicalCall {
	session_id: string;
	turn_id: string;
	turn_index?: number;
	sequence: number;
	order: number;
	tool_call_id: string;
	tool_name: string;
	slice_id: string;
	identity: ToolIdentityDimensions;
	context: CanonicalContext;
	timing: CanonicalTiming;
	requested_input: Record<string, unknown>;
	requested_references: CanonicalReference[];
	executed_input?: Record<string, unknown>;
	executed_references?: CanonicalReference[];
	input: Record<string, unknown>;
	input_references: CanonicalReference[];
	input_key: string;
	ok?: boolean;
	outcome: string;
	error_code?: string;
	output_tokens?: number;
	output_truncated?: boolean;
	duration_ms?: number;
	definition_tokens: number;
	preparation_status?: string;
	repair_operations: string[];
	approval_outcome?: string;
	approval_wait_ms?: number;
	projection_failed?: boolean;
	candidates: CanonicalCandidate[];
	result_references: CanonicalReference[];
	metrics: Record<string, CanonicalMetric>;
	decode_status: "known" | "partial";
	decode_issues: string[];
}

export interface CanonicalToolExposure {
	name: string;
	slice_id: string;
	identity: ToolIdentityDimensions;
	definition_tokens: number;
}

export interface CanonicalTurn {
	id: string;
	session_id: string;
	context?: CanonicalContext;
	interaction?: string;
	branch_lineage?: string;
	turn_index?: number;
	started_at?: string;
	ended_at?: string;
	exposures: CanonicalToolExposure[];
	expected_call_count?: number;
	observed_start_count?: number;
	observed_end_count?: number;
	unfinished_call_count?: number;
	projection_failure_count?: number;
	missing_start_ids: string[];
	missing_end_ids: string[];
}

export interface CanonicalEvent {
	id: string;
	event: string;
	session_id: string;
	sequence?: number;
	timestamp?: string;
	turn_id?: string;
	tool_call_id?: string;
	decode_status: "known" | "partial" | "unknown";
	issues: string[];
}

export interface CollectionIssue {
	issue: string;
	count: number;
	session_id?: string;
	turn_id?: string;
	tool_call_id?: string;
}

export interface IngestDiagnostics {
	decoded_records: number;
	partial_records: number;
	unknown_events: number;
	invalid_records: number;
	duplicate_records: number;
	decode_issue_counts: Record<string, number>;
}

export interface CanonicalDataset {
	calls: CanonicalCall[];
	turns: CanonicalTurn[];
	events: CanonicalEvent[];
	collectionIssues: CollectionIssue[];
	sessionIds: Set<string>;
	sessionStates: Map<string, "open" | "closed">;
	diagnostics: IngestDiagnostics;
	asOf?: string;
}

export interface DecodeContext {
	cwd: string;
}

export type CanonicalCallDraft = Omit<CanonicalCall, "session_id" | "order" | "definition_tokens" | "decode_status" | "decode_issues">;

export type DecodedRecord =
	| { event: "session_start"; cwd: string }
	| { event: "session_end"; unfinished_call_count?: number }
	| { event: "turn_start"; turn: Omit<CanonicalTurn, "session_id"> }
	| { event: "turn_end"; turn: Omit<CanonicalTurn, "session_id" | "exposures" | "started_at"> }
	| { event: "tool_call_start"; turn_id: string; tool_call_id: string }
	| { event: "tool_call"; call: CanonicalCallDraft }
	| { event: "collection_health"; issue: CollectionIssue }
	| { event: "ignored" };

export type TelemetryReadResult =
	| { status: "known"; record: DecodedRecord; raw: Record<string, unknown>; issues: [] }
	| { status: "partial"; record: DecodedRecord; raw: Record<string, unknown>; issues: string[] }
	| { status: "unknown_event"; event: string; raw: Record<string, unknown> }
	| { status: "invalid"; raw: unknown; issues: string[] };
