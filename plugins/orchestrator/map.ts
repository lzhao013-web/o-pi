import { EvaluationError, requiredValue } from "./plan.ts";
import type { SettledCall, SettledMap } from "./progress.ts";
import type { Call, MapInfo, Step } from "./schema.ts";

export function selectItems(mapping: NonNullable<Call["map"]>, results: ReadonlyMap<string, Step>): { info: MapInfo; items: unknown[] } {
	const value = requiredValue(mapping.from, results);
	if (!Array.isArray(value)) throw new EvaluationError("map_source_type", `Map source must be an array: ${mapping.from}.`);
	return { info: { total: value.length, truncated: value.length > mapping.limit }, items: value.slice(0, mapping.limit) };
}

export function settleMap(call: Call, info: MapInfo, data: SettledCall[]): SettledMap {
	const base = { id: call.id, tool: call.tool, map: info, data };
	const errors = data.filter((step) => step.status === "error").length;
	if (errors > 0) return { ...base, status: "error", error: { code: "map_failed", message: `${errors} map item(s) failed.` } };
	const skipped = data.find((step) => step.status === "skipped");
	if (skipped?.status === "skipped") return { ...base, status: "skipped", reason: skipped.reason };
	return { ...base, status: "ok" };
}
