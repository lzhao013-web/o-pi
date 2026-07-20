import { defineToolTelemetry } from "../../telemetry/adapter.js";
import type { ReadFileSuccess, ReadParams, ToolOutcome } from "../types.js";
import { fileMetrics, observation, projectScalarInput, record, resultFileReference } from "./common.js";

export const readTelemetry = defineToolTelemetry<ReadParams, ToolOutcome<ReadFileSuccess>>(import.meta.url, {
	input: projectScalarInput(["path", "start_line", "end_line"]),
	result(params, result) {
		const details = record(result.details);
		const reference = resultFileReference(params.path, details);
		return observation(details, fileMetrics(details), reference === undefined ? [] : [reference]);
	},
});
