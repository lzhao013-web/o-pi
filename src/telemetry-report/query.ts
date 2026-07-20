import type { CanonicalCall, CanonicalDataset } from "./model.js";
import type { AnalysisQuery, ResolvedAnalysisQuery } from "./types.js";
import { environmentId } from "./types.js";

export interface QueryResult {
	filtered_calls: CanonicalCall[];
	selected_calls: CanonicalCall[];
	query: ResolvedAnalysisQuery;
}

/** All report surfaces construct this query and share this single filtering path. */
export function applyAnalysisQuery(dataset: CanonicalDataset, input: AnalysisQuery = {}): QueryResult {
	const latest = input.latest ?? input.slice_ids === undefined;
	const filtered = dataset.calls.filter((call) => matches(call, input));
	const explicit = new Set(input.slice_ids ?? []);
	if (input.baseline_slice_id !== undefined) explicit.add(input.baseline_slice_id);
	if (input.candidate_slice_id !== undefined) explicit.add(input.candidate_slice_id);
	const selectedSliceIds = explicit.size > 0
		? [...explicit]
		: latest ? latestSlices(filtered, dataset, input) : allSliceIds(filtered, dataset, input);
	const selected = new Set(selectedSliceIds);
	return {
		filtered_calls: filtered,
		selected_calls: filtered.filter((call) => selected.has(call.slice_id)),
		query: { ...input, latest, selected_slice_ids: selectedSliceIds },
	};
}

function allSliceIds(calls: readonly CanonicalCall[], dataset: CanonicalDataset, query: AnalysisQuery): string[] {
	const ids = new Set(calls.map((call) => call.slice_id));
	for (const turn of dataset.turns) {
		if (!matchesTurn(turn.context, turn.started_at, query)) continue;
		for (const exposure of turn.exposures) if (includes(query.tools, exposure.name)) ids.add(exposure.slice_id);
	}
	return [...ids].sort(compare);
}

function matches(call: CanonicalCall, query: AnalysisQuery): boolean {
	const model = call.context.model === undefined ? "unknown" : `${call.context.model.provider}/${call.context.model.id}`;
	const timestamp = call.timing.event_at;
	return includes(query.tools, call.tool_name)
		&& includes(query.collector_contracts, call.context.collector_contract)
		&& includes(query.models, model)
		&& includes(query.thinking_levels, call.context.thinking ?? "unknown")
		&& includes(query.toolset_hashes, call.context.toolset?.hash ?? "unknown")
		&& includes(query.projects, call.context.project)
		&& includes(query.environments, environmentId(call.context.environment))
		&& (query.from === undefined || (timestamp !== undefined && timestamp >= query.from))
		&& (query.to === undefined || (timestamp !== undefined && timestamp <= query.to));
}

function latestSlices(calls: readonly CanonicalCall[], dataset: CanonicalDataset, query: AnalysisQuery): string[] {
	const latest = new Map<string, { slice: string; timestamp: string; sequence: number }>();
	for (const call of calls) {
		const timestamp = call.timing.event_at ?? "";
		const current = latest.get(call.tool_name);
		if (current === undefined || timestamp > current.timestamp || (timestamp === current.timestamp && call.sequence > current.sequence)) {
			latest.set(call.tool_name, { slice: call.slice_id, timestamp, sequence: call.sequence });
		}
	}
	for (const turn of dataset.turns) {
		if (!matchesTurn(turn.context, turn.started_at, query)) continue;
		for (const exposure of turn.exposures) {
			if (!includes(query.tools, exposure.name)) continue;
			const timestamp = turn.started_at ?? "";
			const current = latest.get(exposure.name);
			if (current === undefined || timestamp > current.timestamp) latest.set(exposure.name, { slice: exposure.slice_id, timestamp, sequence: -1 });
		}
	}
	return [...latest.values()].map((value) => value.slice).sort(compare);
}

function matchesTurn(context: CanonicalDataset["turns"][number]["context"], timestamp: string | undefined, query: AnalysisQuery): boolean {
	if (context === undefined) return query.collector_contracts === undefined && query.models === undefined && query.thinking_levels === undefined
		&& query.toolset_hashes === undefined && query.projects === undefined && query.environments === undefined;
	const model = context.model === undefined ? "unknown" : `${context.model.provider}/${context.model.id}`;
	return includes(query.collector_contracts, context.collector_contract)
		&& includes(query.models, model)
		&& includes(query.thinking_levels, context.thinking ?? "unknown")
		&& includes(query.toolset_hashes, context.toolset?.hash ?? "unknown")
		&& includes(query.projects, context.project)
		&& includes(query.environments, environmentId(context.environment))
		&& (query.from === undefined || (timestamp !== undefined && timestamp >= query.from))
		&& (query.to === undefined || (timestamp !== undefined && timestamp <= query.to));
}

function includes(values: readonly string[] | undefined, value: string): boolean {
	return values === undefined || values.length === 0 || values.includes(value);
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
