import { defineToolTelemetry } from "../../telemetry/adapter.js";
import { compactJson, isRecord, scalar, textSummary } from "../../telemetry/projectors.js";
import type { ToolOutcome, WriteParams, WriteSuccess } from "../types.js";
import { contentHash, fileMetrics, observation, pathReference, projection, record, resultFileReference, string } from "./common.js";

export const writeTelemetry = defineToolTelemetry<WriteParams, ToolOutcome<WriteSuccess>>(import.meta.url, {
	input(value) {
		if (!isRecord(value)) return { value: {} };
		return projection(
			compactJson({ path: scalar(value["path"]), content: textSummary(value["content"]) }),
			pathReference(string(value["path"]), undefined, undefined, contentHash(value["content"])),
		);
	},
	result(params, result) {
		const details = record(result.details);
		const reference = resultFileReference(params.path, details);
		return observation(details, fileMetrics(details), reference === undefined ? [] : [reference]);
	},
});
