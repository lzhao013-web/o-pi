import { fields, isRecord, scalar, textFields } from "../telemetry/projection.js";
import { defineToolTelemetry } from "../telemetry/tool.js";
import type { BashParams, BashToolDetails } from "./types.js";

export const bashTelemetry = defineToolTelemetry<BashParams, BashToolDetails>({
	input(value) {
		if (!isRecord(value)) return {};
		return {
			fields: fields({
				input_timeout_seconds: scalar(value["timeout"]),
				...textFields("input_command", value["command"]),
			}),
		};
	},
	result(_params, result) {
		const details = result.details;
		return {
			fields: fields({
				status: details.status,
				exit_code: details.exit_code,
				output_state: details.output_state,
				output_format: details.output_format,
				capture_complete: details.capture_complete,
				total_line_count: details.total_lines,
				returned_line_count: details.returned_lines,
				total_size_bytes: details.total_bytes,
				returned_size_bytes: details.returned_bytes,
				truncated: details.output_state === "truncated" || details.output_state === "capture_truncated",
			}),
		};
	},
});
