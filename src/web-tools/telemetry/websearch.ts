import { defineToolTelemetry } from "../../telemetry/adapter.js";
import { compactJson, isRecord, scalar } from "../../telemetry/projectors.js";
import type { TelemetryReference } from "../../telemetry/types.js";
import type { WebSearchDetails, WebSearchParams } from "../types.js";
import { errorCode, number, record, string, webMetrics } from "./common.js";

export const webSearchTelemetry = defineToolTelemetry<WebSearchParams, WebSearchDetails>(import.meta.url, {
	input(value) {
		if (!isRecord(value)) return { value: {} };
		return { value: compactJson({ query: scalar(value["query"]), limit: scalar(value["limit"]) }) };
	},
	result(_params, result) {
		const details = record(result.details);
		const status = string(details["status"]);
		const code = errorCode(details);
		return {
			metrics: webMetrics(details),
			references: webCandidates(details),
			...(status === undefined ? {} : { status }),
			...(code === undefined ? {} : { error_code: code }),
		};
	},
});

function webCandidates(details: Record<string, unknown>): TelemetryReference[] {
	const provider = string(details["provider"]) ?? "provider";
	const results = Array.isArray(details["results"]) ? details["results"].filter(isRecord) : [];
	return results.flatMap((item, index) => {
		const url = string(item["url"]);
		const sourceRank = number(item["rank"]);
		return url === undefined ? [] : [{
			relation: "candidate",
			global_rank: index + 1,
			group_rank: index + 1,
			kind: "url",
			value: url,
			group: "primary",
			sources: [{ id: provider, family: "websearch", ...(sourceRank === undefined ? {} : { source_rank: sourceRank }) }],
		}];
	});
}
