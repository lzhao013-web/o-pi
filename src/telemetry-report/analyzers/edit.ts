import type { CallRecord } from "../../telemetry/types.js";
import { numericSummary, resourceKey } from "../shared.js";
import type { EditBatchStatistics, EditReport } from "../types.js";

export function analyzeEdits(calls: readonly CallRecord[], cwdByRun: ReadonlyMap<string, string> = new Map()): EditReport {
	const edits = calls.filter((call) => call.tool === "edit");
	return {
		calls: edits.length,
		successful_calls: edits.filter((call) => call.status === "success").length,
		failed_calls: edits.filter((call) => call.status === "error").length,
		no_change_calls: edits.filter((call) => call.fields?.["changed"] === false).length,
		edits_per_call: numericSummary(edits.flatMap((call) => number(call.fields?.["input_edit_count"]) ?? [])),
		batches: batchStatistics(edits, cwdByRun),
	};
}

function batchStatistics(calls: readonly CallRecord[], cwdByRun: ReadonlyMap<string, string>): EditBatchStatistics {
	const grouped = new Map<string, CallRecord[]>();
	for (const call of calls) {
		if (call.batch === undefined || call.batch.size <= 1) continue;
		const key = `${call.run_id}\0${call.batch.id}`;
		const values = grouped.get(key);
		if (values === undefined) grouped.set(key, [call]);
		else values.push(call);
	}
	const batches = [...grouped.values()];
	const fileCounts = batches.map((batch) => new Set(batch.flatMap((call) => {
		const cwd = cwdByRun.get(call.run_id) ?? ".";
		return (call.targets ?? []).map((target) => resourceKey(target, cwd));
	})).size);
	let partialFailures = 0;
	let potentialReduction = 0;
	for (const [index, batch] of batches.entries()) {
		const successes = batch.filter((call) => call.status === "success").length;
		if (successes > 0 && successes < batch.length) partialFailures += 1;
		if ((fileCounts[index] ?? 0) > 1) potentialReduction += Math.max(0, batch.length - 1);
	}
	return {
		batches: batches.length,
		multi_file_batches: fileCounts.filter((count) => count > 1).length,
		partial_failure_batches: partialFailures,
		calls_per_batch: numericSummary(batches.map((batch) => batch.length)),
		files_per_batch: numericSummary(fileCounts),
		potential_call_reduction: potentialReduction,
	};
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
