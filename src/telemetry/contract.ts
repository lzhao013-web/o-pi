import { createManifest } from "./manifest.js";
import { sourceBundleDescriptor } from "./source-identity.js";
import type { JsonObject } from "./types.js";

/**
 * Machine-readable semantics plus the complete collector implementation closure.
 * The source closure deliberately prefers harmless false-positive splits over
 * silently aggregating records whose semantics changed.
 */
export const COLLECTOR_CONTRACT_DESCRIPTOR: JsonObject = {
	events: {
		session_start: ["reason"],
		turn_start: ["tools", "definition_tokens", "repo_map", "workload"],
		tool_call_start: ["tool", "identity", "requested_input", "envelope_timestamp"],
		tool_execution_start: ["requested", "executed", "preparation", "approval", "envelope_timestamp"],
		tool_call_end: ["timing", "input", "annotations", "result", "observation"],
		turn_end: ["expected_calls", "observed_calls", "unfinished_calls", "projection_failures", "projection_limits"],
		collection_health: ["issue", "count", "details"],
		session_end: ["reason", "unfinished_calls"],
	},
	envelope: {
		identity: ["id", "session_id", "run_id", "stream_id", "sequence"],
		ordering: "sequence_is_contiguous_within_session_run_stream",
	},
	lifecycle: {
		key: ["session_id", "run_id", "tool_call_id"],
		phase: ["declared", "executing", "ended"],
		terminal_status: ["completed", "blocked", "validation_failed", "unfinished"],
		merge: ["tool_call_start", "tool_execution_start", "tool_call_end"],
	},
	outcomes: ["success", "validation_error", "blocked", "timeout", "aborted", "exception", "tool_error", "missing_result"],
	timing: {
		timestamps: "utc_wall_clock_at_collector_boundary",
		durations: "monotonic_process_clock",
		fields: ["start_to_execute_ms", "execution_duration_ms", "call_duration_ms", "approval_wait_ms"],
		missing: "absent",
	},
	projection: {
		json: "finite_bounded_json_values",
		input: "adapter_allowlist",
		output: "no_body_summary_and_adapter_observation",
		observation: ["typed_metrics", "references", "attributes", "measurements", "stages"],
		limits: { max_depth: 8, max_nodes: 4096, max_string_chars: 4096, max_array_items: 256, max_object_keys: 128 },
	},
	implementation: sourceBundleDescriptor([
		"src/telemetry/types.ts",
		"src/telemetry/adapter.ts",
		"src/telemetry/channel.ts",
		"src/telemetry/runtime.ts",
		"src/telemetry/record.ts",
		"src/telemetry/collector.ts",
		"src/telemetry/writer.ts",
	]),
};

export const COLLECTOR_CONTRACT_MANIFEST = createManifest("collector_contract", COLLECTOR_CONTRACT_DESCRIPTOR);
export const COLLECTOR_CONTRACT_HASH = COLLECTOR_CONTRACT_MANIFEST.hash;
