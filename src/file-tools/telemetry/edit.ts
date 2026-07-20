import { defineToolTelemetry } from "../../telemetry/adapter.js";
import { compactJson, isRecord, scalar, textSummary } from "../../telemetry/projectors.js";
import type { EditParams, EditSuccess, ToolOutcome } from "../types.js";
import { fileMetrics, observation, pathReference, projection, record, string } from "./common.js";

export const editTelemetry = defineToolTelemetry<EditParams, ToolOutcome<EditSuccess>>(import.meta.url, {
	input(value) {
		if (!isRecord(value)) return { value: {} };
		const edits = Array.isArray(value["edits"])
			? value["edits"].filter(isRecord).map((edit) => compactJson({ old: textSummary(edit["old"]), new: textSummary(edit["new"]) }))
			: undefined;
		return projection(compactJson({ path: scalar(value["path"]), edits }), pathReference(string(value["path"])));
	},
	result(_params, result) {
		const details = record(result.details);
		return observation(details, fileMetrics(details), []);
	},
});
