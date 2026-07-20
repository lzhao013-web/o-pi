import { defineToolTelemetry } from "../telemetry/adapter.js";
import { bytesMetric, categoricalMetric, compactJson, countMetric, durationMetric, isRecord, scalar } from "../telemetry/projectors.js";
import type { MetricMap, ToolObservation } from "../telemetry/types.js";
import type { BashParams, BashToolDetails } from "./types.js";

export const bashTelemetry = defineToolTelemetry<BashParams, BashToolDetails>(import.meta.url, {
	input(value) {
		if (!isRecord(value)) return { value: {} };
		const command = typeof value["command"] === "string" ? value["command"] : undefined;
		return {
			value: compactJson({ command: scalar(value["command"]), timeout: scalar(value["timeout"]) }),
			...(command === undefined ? {} : { references: [{ relation: "target", kind: "command", value: command }] }),
		};
	},
	result(_params, result): ToolObservation {
		const details = result.details;
		const metrics: MetricMap = {
			status: categoricalMetric(details.status),
			output_state: categoricalMetric(details.output_state),
			output_format: categoricalMetric(details.output_format),
			capture_complete: categoricalMetric(details.capture_complete),
			duration: durationMetric(details.duration_ms),
			total_lines: countMetric(details.total_lines, "line"),
			returned_lines: countMetric(details.returned_lines, "line"),
			total_bytes: bytesMetric(details.total_bytes),
			returned_bytes: bytesMetric(details.returned_bytes),
		};
		if (details.exit_code !== undefined) metrics["exit_code"] = categoricalMetric(details.exit_code);
		return {
			metrics,
			status: details.status,
			truncated: details.output_state === "truncated" || details.output_state === "capture_truncated",
		};
	},
});
