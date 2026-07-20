import { defineToolTelemetry } from "../../telemetry/adapter.js";
import type { TelemetryReference } from "../../telemetry/types.js";
import type { FailedResult, FindDetails, FindParams } from "../types.js";
import { appendPathCandidates, fileMetrics, observation, projectScalarInput, record, sourceLabels } from "./common.js";

export const findTelemetry = defineToolTelemetry<FindParams, FindDetails | FailedResult>(import.meta.url, {
	input: projectScalarInput(["query", "path", "glob"]),
	result(_params, result) {
		const details = record(result.details);
		return observation(details, fileMetrics(details), findCandidates(details));
	},
});

function findCandidates(details: Record<string, unknown>): TelemetryReference[] {
	const result: TelemetryReference[] = [];
	const sourceMap = record(details["candidateSources"]);
	const strategy = details["strategy"] === "fuzzy" ? "fuzzy" : "lexical";
	appendPathCandidates(result, details["displayedMatches"] ?? details["matches"], "primary", (path) => {
		const labels = sourceLabels(sourceMap[path], strategy);
		return strategy === "fuzzy" ? [...new Set([...labels, "fuzzy"])].sort() : labels;
	});
	appendPathCandidates(result, details["displayedCollapsedGroups"] ?? details["collapsedGroups"], "collapsed", () => ["collapsed"], "group");
	appendPathCandidates(result, details["nearby"], "nearby", () => ["fuzzy"]);
	appendPathCandidates(result, details["related"], "related", () => ["repo-map"]);
	return result;
}
