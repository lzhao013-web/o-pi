import type { RepairOperation, ToolArgumentStatus } from "../tool-repair/types.js";
import type { ApprovalTelemetry } from "../approval/types.js";

export type { RepairOperation, ToolArgumentStatus } from "../tool-repair/types.js";
export type { ApprovalTelemetry } from "../approval/types.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type MetricValue = string | number | boolean;

/** Open, tool-independent metric. A published name/unit pair never changes meaning. */
export interface TelemetryMetric {
	value: MetricValue;
	unit?: string;
}

export type MetricMap = Record<string, TelemetryMetric>;

/** Open semantic reference shared by tool inputs and results. */
export interface TelemetryReference {
	relation: string;
	kind: string;
	value: string;
	rank?: number;
	group?: string;
	sources?: string[];
	start_line?: number;
	end_line?: number;
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
	truncated?: boolean;
	status?: string;
	error_code?: string;
}

export interface ToolRuntimeTelemetry {
	tool_call_id: string;
	tool_name: string;
	cohort_id?: string;
	input: {
		requested: InputProjection;
		executed?: InputProjection;
	};
	preparation?: ToolPreparationTelemetry;
	approval?: ApprovalTelemetry;
	execute?: ExecuteTelemetry;
	observation?: ToolObservation;
	projection_failed?: boolean;
}

export interface TelemetryContext {
	cwd: string;
	model?: { provider: string; id: string };
	thinking_level?: string;
	toolset_hash?: string;
}

/** Permanent event envelope. New capabilities are optional fields inside data. */
export interface TelemetryBase {
	id: string;
	timestamp: string;
	session_id: string;
	sequence: number;
	context: TelemetryContext;
}

export interface SessionStartRecord extends TelemetryBase {
	event: "session_start";
	data: {
		reason: "startup" | "reload" | "new" | "resume" | "fork";
	};
}

export interface TurnStartRecord extends TelemetryBase {
	event: "turn_start";
	turn_id: string;
	data: {
		turn_index: number;
		active_tools: string[];
		toolset_hash: string;
		tool_definitions: Array<{ name: string; estimated_tokens: number }>;
		repo_map: {
			enabled: boolean;
			freshness?: string;
			map_id?: string;
		};
	};
}

export interface ToolCallRecord extends TelemetryBase {
	event: "tool_call";
	turn_id: string;
	tool_call_id: string;
	data: {
		turn_index: number;
		tool: {
			name: string;
			cohort: string;
		};
		input: {
			requested: InputProjection;
			executed?: InputProjection;
		};
		annotations: {
			preparation?: ToolPreparationTelemetry;
			approval?: ApprovalTelemetry;
			execution?: ExecuteTelemetry;
			projection_failed?: boolean;
		};
		result: {
			ok?: boolean;
			outcome: string;
			error?: {
				source: string;
				code?: string;
			};
			output: {
				text_chars: number;
				estimated_tokens: {
					value: number;
					method: string;
				};
				truncated: boolean;
			};
			metrics: MetricMap;
			references: TelemetryReference[];
		};
	};
}

export interface TurnEndRecord extends TelemetryBase {
	event: "turn_end";
	turn_id: string;
	data: {
		turn_index: number;
		tool_calls: number;
		duration_ms: number;
	};
}

export interface SessionEndRecord extends TelemetryBase {
	event: "session_end";
	data: {
		reason: "quit" | "reload" | "new" | "resume" | "fork";
	};
}

export type TelemetryRecord = SessionStartRecord | TurnStartRecord | ToolCallRecord | TurnEndRecord | SessionEndRecord;
