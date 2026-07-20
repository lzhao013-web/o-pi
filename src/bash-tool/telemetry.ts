import { defineToolTelemetry } from "../telemetry/adapter.js";
import { compactJson, isRecord, scalar, selectedMetrics } from "../telemetry/projectors.js";
import type { ToolObservation } from "../telemetry/types.js";
import type { BashParams, BashToolDetails } from "./types.js";

export const bashTelemetry = defineToolTelemetry<BashParams, BashToolDetails>({
	projectRequested(value) {
		if (!isRecord(value)) return { value: {} };
		const command = typeof value["command"] === "string" ? value["command"] : undefined;
		return {
			value: compactJson({ command: scalar(value["command"]), timeout: scalar(value["timeout"]) }),
			...(command === undefined ? {} : { references: [{ relation: "target", kind: "command", value: command }] }),
		};
	},
	projectExecuted(params) {
		return {
			value: compactJson({ command: params.command, timeout: params.timeout }),
			references: [{ relation: "target", kind: "command", value: params.command }],
		};
	},
	observeResult(_params, result): ToolObservation {
		const details = result.details;
		const detailRecord: Record<string, unknown> = { ...details };
		return {
			metrics: selectedMetrics(detailRecord, [
				"status",
				"exit_code",
				"output_state",
				"output_format",
				"total_lines",
				"returned_lines",
				"total_bytes",
				"returned_bytes",
				"capture_complete",
			]),
			status: details.status,
			truncated: details.output_state === "truncated" || details.output_state === "capture_truncated",
		};
	},
});
