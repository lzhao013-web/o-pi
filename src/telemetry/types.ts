import type { RepairOperation, ToolArgumentStatus } from "../tool-repair/types.js";
import type { ApprovalTelemetry } from "../approval/types.js";

export type { RepairOperation, ToolArgumentStatus } from "../tool-repair/types.js";
export type { ApprovalTelemetry } from "../approval/types.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type MetricValue = string | number | boolean;

export type MetricKind = "categorical" | "count" | "distribution" | "duration" | "bytes" | "ratio";
export type MetricAggregation = "count_by_value" | "sum" | "distribution" | "mean";

/** Metric semantics are part of the raw schema, not an analyzer guess. */
export type TelemetryMetric =
	| { kind: "categorical"; aggregation: "count_by_value"; value: MetricValue }
	| { kind: "count"; aggregation: "sum"; value: number; unit: string }
	| { kind: "distribution"; aggregation: "distribution"; value: number; unit: string }
	| { kind: "duration"; aggregation: "distribution"; value: number; unit: "ms" | "s" }
	| { kind: "bytes"; aggregation: "sum" | "distribution"; value: number; unit: "byte" }
	| { kind: "ratio"; aggregation: "mean"; value: number; unit: "ratio" };

export type MetricMap = Record<string, TelemetryMetric>;

export interface Measurement {
	name: string;
	value: number;
	unit?: string;
}

export interface StageObservation {
	name: string;
	status?: string;
	duration_ms?: number;
	attributes?: JsonObject;
	measurements?: Measurement[];
}

export interface TelemetryReferenceSource {
	id: string;
	family?: string;
	source_rank?: number;
}

export interface TelemetryResourceState {
	content_hash?: { algorithm: "sha256"; value: string };
	snapshot?: string;
	revision?: string;
	start_line?: number;
	end_line?: number;
}

/** Open semantic reference shared by tool inputs and results. */
export interface TelemetryReference {
	relation: string;
	kind: string;
	value: string;
	group?: string;
	global_rank?: number;
	group_rank?: number;
	sources?: TelemetryReferenceSource[];
	resource?: TelemetryResourceState;
}

export interface InputProjection {
	value: JsonObject;
	references?: TelemetryReference[];
}

export interface ExecuteTelemetry {
	duration_ms: number;
	state: "returned" | "threw";
	error_name?: string;
	signal_aborted: boolean;
}

export interface ToolPreparationTelemetry {
	status: ToolArgumentStatus;
	operations: RepairOperation[];
}

/** Tool-local adapters return this payload-free, open observation. */
export interface ToolObservation {
	metrics?: MetricMap;
	references?: TelemetryReference[];
	attributes?: JsonObject;
	measurements?: Measurement[];
	stages?: StageObservation[];
	truncated?: boolean;
	status?: string;
	error_code?: string;
}

export interface ToolIdentity {
	behavior_hash: string;
	definition_hash: string;
	telemetry_hash: string;
	config_hash: string;
}

export interface ToolRuntimeTelemetry {
	tool_call_id: string;
	tool_name: string;
	input: {
		requested: InputProjection;
		executed?: InputProjection;
	};
	preparation?: ToolPreparationTelemetry;
	approval?: ApprovalTelemetry;
	execute?: ExecuteTelemetry;
	observation?: ToolObservation;
	projection_failed?: boolean;
	projection_limited?: boolean;
}

export interface WorkloadTelemetry {
	prompt_hash: string;
	shape: string;
	prompt_chars: number;
	prompt_tokens: { value: number; method: string };
	image_count: number;
}

export interface TelemetryContext {
	cwd: string;
	model?: { provider: string; id: string };
	thinking_level?: string;
	toolset?: { active: string[]; hash: string };
	workload?: WorkloadTelemetry;
	host: {
		pi_version: string;
		mode?: string;
		platform: NodeJS.Platform;
		arch: string;
		node_version: string;
	};
	branch?: {
		leaf_id?: string;
		lineage_hash: string;
		depth: number;
	};
}

export interface TelemetryBase {
	id: string;
	timestamp: string;
	session_id: string;
	run_id: string;
	stream_id: string;
	collector_contract_hash: string;
	sequence: number;
	context: TelemetryContext;
}

export interface CallDimensions {
	interaction_id?: string;
	assistant_message_id?: string;
	tool_batch_id?: string;
	batch_size?: number;
	batch_index?: number;
}

export interface SessionStartRecord extends TelemetryBase {
	event: "session_start";
	data: { reason: "startup" | "reload" | "new" | "resume" | "fork" };
}

export interface ToolExposure extends ToolIdentity {
	name: string;
	definition_tokens: { value: number; method: string };
}

export interface TurnStartRecord extends TelemetryBase {
	event: "turn_start";
	turn_id: string;
	interaction_id?: string;
	data: {
		turn_index: number;
		tools: ToolExposure[];
		repo_map: { enabled: boolean; freshness?: string; map_id?: string };
	};
}

export interface ToolCallStartRecord extends TelemetryBase, CallDimensions {
	event: "tool_call_start";
	turn_id: string;
	tool_call_id: string;
	data: {
		turn_index: number;
		tool: { name: string; identity: ToolIdentity };
		input: { requested: InputProjection };
		projection_failed?: boolean;
		projection_limited?: boolean;
	};
}

export interface ToolExecutionStartRecord extends TelemetryBase, CallDimensions {
	event: "tool_execution_start";
	turn_id: string;
	tool_call_id: string;
	data: {
		turn_index: number;
		tool: { name: string; identity: ToolIdentity };
		input: { requested: InputProjection; executed: InputProjection };
		preparation?: ToolPreparationTelemetry;
		approval?: ApprovalTelemetry;
		projection_failed?: boolean;
		projection_limited?: boolean;
	};
}

export interface ToolCallEndRecord extends TelemetryBase, CallDimensions {
	event: "tool_call_end";
	turn_id: string;
	tool_call_id: string;
	data: {
		turn_index: number;
		tool: { name: string; identity: ToolIdentity };
		timing: {
			call_started_at: string;
			execution_started_at?: string;
			execution_ended_at?: string;
			execution_duration_ms?: number;
			call_duration_ms: number;
		};
		input: { requested: InputProjection; executed?: InputProjection };
		annotations: {
			preparation?: ToolPreparationTelemetry;
			approval?: ApprovalTelemetry;
			execution?: ExecuteTelemetry;
			projection_failed?: boolean;
			projection_limited?: boolean;
		};
		result: {
			ok?: boolean;
			outcome: string;
			error?: { source: string; code?: string };
			output: {
				text_chars: number;
				estimated_tokens: { value: number; method: string };
				truncated: boolean;
			};
			metrics: MetricMap;
			references: TelemetryReference[];
			attributes?: JsonObject;
			measurements?: Measurement[];
			stages?: StageObservation[];
		};
	};
}

export interface TurnEndRecord extends TelemetryBase {
	event: "turn_end";
	turn_id: string;
	interaction_id?: string;
	data: {
		turn_index: number;
		duration_ms: number;
		expected_call_count: number;
		observed_start_count: number;
		observed_end_count: number;
		unfinished_call_count: number;
		projection_failure_count: number;
		projection_limit_count: number;
		missing_start_ids: string[];
		missing_end_ids: string[];
	};
}

export type CollectionHealthIssue =
	| "invalid_jsonl"
	| "sequence_gap"
	| "missing_start"
	| "missing_end"
	| "unfinished_turn"
	| "projection_failed"
	| "projection_limited"
	| "metric_schema_conflict"
	| "writer_failure"
	| "collector_handler_failure"
	| "session_hydration_failure"
	| "identity_resolution_failure"
	| "config_capture_failure"
	| "runtime_event_drop"
	| "context_capture_failure"
	| "manifest_write_failure"
	| "live_store_truncated";

export interface CollectionHealthRecord extends TelemetryBase {
	event: "collection_health";
	turn_id?: string;
	tool_call_id?: string;
	data: {
		issue: CollectionHealthIssue;
		count?: number;
		details?: JsonObject;
	};
}

export interface SessionEndRecord extends TelemetryBase {
	event: "session_end";
	data: {
		reason: "quit" | "reload" | "new" | "resume" | "fork";
		unfinished_turn_id?: string;
		unfinished_call_count: number;
	};
}

export type TelemetryRecord =
	| SessionStartRecord
	| TurnStartRecord
	| ToolCallStartRecord
	| ToolExecutionStartRecord
	| ToolCallEndRecord
	| TurnEndRecord
	| CollectionHealthRecord
	| SessionEndRecord;
