import { fields, isRecord, scalar, textFields } from "../../telemetry/projection.js";
import { defineToolTelemetry } from "../../telemetry/tool.js";
import type { Candidate } from "../../telemetry/types.js";
import type { WebSearchDetails, WebSearchParams } from "../types.js";
import { record, string, webResultFields } from "./common.js";

export const webSearchTelemetry = defineToolTelemetry<WebSearchParams, WebSearchDetails>({
	input(value) {
		if (!isRecord(value)) return {};
		return { fields: fields({ ...textFields("input_query", value["query"]), input_limit: scalar(value["limit"]) }) };
	},
	result(_params, result) {
		const details = record(result.details);
		return {
			fields: webResultFields(details),
			candidates: webCandidates(details),
		};
	},
});

function webCandidates(details: Record<string, unknown>): Candidate[] {
	const provider = string(details["provider"]) ?? "provider";
	const results = Array.isArray(details["results"]) ? details["results"].filter(isRecord) : [];
	return results.flatMap((item, index) => {
		const url = string(item["url"]);
		if (url === undefined) return [];
		return [{
			kind: "url",
			value: url,
			rank: index + 1,
			group: "primary",
			sources: [provider],
		}];
	});
}
