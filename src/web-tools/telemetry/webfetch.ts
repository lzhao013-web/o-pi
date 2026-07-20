import { defineToolTelemetry } from "../../telemetry/adapter.js";
import { compactJson, isRecord, scalar } from "../../telemetry/projectors.js";
import type { WebFetchDetails, WebFetchParams } from "../types.js";
import { errorCode, record, string, webMetrics } from "./common.js";

export const webFetchTelemetry = defineToolTelemetry<WebFetchParams, WebFetchDetails>(import.meta.url, {
	input(value) {
		if (!isRecord(value)) return { value: {} };
		const url = string(value["url"]);
		return {
			value: compactJson({
				url: scalar(value["url"]),
				mode: scalar(value["mode"]),
				offset: scalar(value["offset"]),
				limit: scalar(value["limit"]),
			}),
			...(url === undefined ? {} : { references: [{ relation: "target", kind: "url", value: url }] }),
		};
	},
	result(_params, result) {
		const details = record(result.details);
		const range = record(details["range"]);
		const status = string(details["status"]);
		const code = errorCode(details);
		return {
			metrics: webMetrics(details),
			truncated: range["has_more"] === true,
			...(status === undefined ? {} : { status }),
			...(code === undefined ? {} : { error_code: code }),
		};
	},
});
