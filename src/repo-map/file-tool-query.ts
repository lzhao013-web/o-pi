import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { computeRepoMapActivation, evaluateRepoMapGate } from "./activation.js";
import { RepoMapQueryIndex, type RepoMapQueryResult } from "./query.js";
import type { RepoMapGeneration } from "./storage.js";

export interface RepoMapFileToolQuery {
	query(input: { requestedPath: string; query: string; limit: number }): Promise<RepoMapQueryResult | undefined>;
}

export interface RepoMapFileToolQueryDependencies {
	readActivated(activation: { root: string; mapId: string; generation: string }): Promise<RepoMapGeneration | undefined>;
}

/** 未激活时只计算 session entry；磁盘读取、generation 校验与查询均延后到调用时。 */
export function createRepoMapFileToolQuery(
	getBranch: () => SessionEntry[],
	dependencies: Partial<RepoMapFileToolQueryDependencies> = {},
): RepoMapFileToolQuery {
	const readActivated = dependencies.readActivated ?? (async (activation) =>
		await (await import("./service.js")).readActivatedRepoMap(activation));
	return {
		async query(input) {
			try {
				const activation = computeRepoMapActivation(getBranch());
				if (activation === undefined) return undefined;
				const generation = await readActivated(activation);
				const gate = evaluateRepoMapGate({
					activation,
					...(generation === undefined ? {} : {
						map: {
							root: generation.metadata.repositoryRoot,
							mapId: generation.metadata.mapId,
							generation: generation.metadata.generation,
							freshness: generation.metadata.freshness,
						},
					}),
					requestedPath: input.requestedPath,
				});
				if (!gate.enabled || generation === undefined) return undefined;
				return new RepoMapQueryIndex(generation).candidates(input.query, input.limit);
			} catch {
				return undefined;
			}
		},
	};
}
