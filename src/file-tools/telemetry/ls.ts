import { defineToolTelemetry } from "../../telemetry/adapter.js";
import { isRecord } from "../../telemetry/projectors.js";
import type { TelemetryReference } from "../../telemetry/types.js";
import type { LsParams, LsSuccess, ToolOutcome } from "../types.js";
import { candidate, fileMetrics, observation, projectScalarInput, record, string } from "./common.js";

export const lsTelemetry = defineToolTelemetry<LsParams, ToolOutcome<LsSuccess>>(import.meta.url, {
	input: projectScalarInput(["path"]),
	result(_params, result) {
		const details = record(result.details);
		return observation(details, fileMetrics(details), lsCandidates(details));
	},
});

function lsCandidates(details: Record<string, unknown>): TelemetryReference[] {
	const entries = Array.isArray(details["entries"]) ? details["entries"].filter(isRecord) : [];
	return entries.flatMap((entry, index) => {
		const path = string(entry["path"]);
		if (path === undefined) return [];
		const kind = entry["type"] === "directory" ? "directory" : entry["type"] === "file" ? "file" : "path";
		return [candidate(index + 1, index + 1, kind, path, "primary", ["filesystem"])];
	});
}
