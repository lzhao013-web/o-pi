import { defineToolTelemetry } from "../../telemetry/adapter.js";
import type { TelemetryReference } from "../../telemetry/types.js";
import type { GrepParams, GrepSuccess, ToolOutcome } from "../types.js";
import { appendRegionCandidates, fileMetrics, observation, projectScalarInput, record, sourceLabels } from "./common.js";

export const grepTelemetry = defineToolTelemetry<GrepParams, ToolOutcome<GrepSuccess>>(import.meta.url, {
	input: projectScalarInput(["query", "path", "match", "glob"]),
	result(_params, result) {
		const details = record(result.details);
		return observation(details, fileMetrics(details), grepCandidates(details));
	},
});

function grepCandidates(details: Record<string, unknown>): TelemetryReference[] {
	const result: TelemetryReference[] = [];
	appendRegionCandidates(result, details["regions"], "primary", (item) => sourceLabels(item["sources"], "lexical"));
	appendRegionCandidates(result, details["nearby"], "nearby", () => ["fuzzy"]);
	appendRegionCandidates(result, details["related"], "related", () => ["repo-map"]);
	return result;
}
