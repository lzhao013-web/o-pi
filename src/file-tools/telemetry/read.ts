import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { ReadFileSuccess, ReadParams, ToolOutcome } from "../types.js";
import { fileResultFields, projectFileInput, record } from "./common.js";

export const readTelemetry = defineToolTelemetry<ReadParams, ToolOutcome<ReadFileSuccess>>({
	input: projectFileInput(["path", "start_line", "end_line"], "file"),
	result(_params, result) {
		const details = record(result.details);
		return { fields: fileResultFields(details) };
	},
});
