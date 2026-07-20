export interface CanonicalReference {
	relation: string;
	kind: string;
	value: string;
	rank?: number;
	group?: string;
	sources: string[];
	start_line?: number;
	end_line?: number;
}

export interface CanonicalCandidate extends CanonicalReference {
	relation: "candidate";
	rank: number;
	group: string;
}

export interface CanonicalMetric {
	value: string | number | boolean;
	unit?: string;
}

export interface CanonicalCall {
	session_id: string;
	turn_id: string;
	order: number;
	timestamp?: string;
	tool_call_id: string;
	tool_name: string;
	cohort_id: string;
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
	cwd: string;
}

export interface CanonicalTurn {
	id: string;
	sessionId: string;
	activeTools: string[];
	definitions: Map<string, number>;
}

export interface IngestDiagnostics {
	decoded_records: number;
	partial_records: number;
	unknown_events: number;
	invalid_records: number;
	duplicate_records: number;
}

export interface CanonicalDataset {
	calls: CanonicalCall[];
	turns: CanonicalTurn[];
	sessionIds: Set<string>;
	diagnostics: IngestDiagnostics;
}

export interface DecodeContext {
	cwd: string;
}

export type CanonicalCallDraft = Omit<CanonicalCall, "session_id" | "order" | "definition_tokens">;

export type DecodedRecord =
	| { event: "session_start"; cwd: string }
	| { event: "turn_start"; turn_id: string; active_tools: string[]; definitions: Map<string, number> }
	| { event: "tool_call"; call: CanonicalCallDraft }
	| { event: "ignored" };

export type TelemetryReadResult =
	| { status: "known"; record: DecodedRecord; raw: Record<string, unknown>; issues: [] }
	| { status: "partial"; record: DecodedRecord; raw: Record<string, unknown>; issues: string[] }
	| { status: "unknown_event"; event: string; raw: Record<string, unknown> }
	| { status: "invalid"; raw: unknown; issues: string[] };
