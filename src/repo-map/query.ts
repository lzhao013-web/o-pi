import path from "node:path";

import type { SourceRange } from "../code-index/types.js";
import type { RepoMapGeneration } from "./storage.js";
import type { RepoMapArchitectureNode, RepoMapEdge, RepoMapEvidence, RepoMapFileRecord, RepoMapSymbolNode } from "./types.js";

export type RepoMapMatchReason =
	| "exact path"
	| "exact filename"
	| "path match"
	| "exact qualified symbol"
	| "exact symbol"
	| "short symbol"
	| "signature"
	| "definition"
	| "export"
	| "reference"
	| "caller"
	| "callee"
	| "import"
	| "package"
	| "component"
	| "entrypoint"
	| "registration"
	| "public api";

export interface RepoMapRelatedEdge {
	kind: RepoMapEdge["kind"];
	from: string;
	to: string;
	confidence: number;
	resolution: RepoMapEdge["resolution"];
	source: RepoMapEdge["source"];
	evidence: RepoMapEvidence[];
	relatedFiles: Array<{ path: string; contentHash?: string }>;
}

export interface RepoMapQueryCandidate {
	path: string;
	fileId: string;
	contentHash?: string;
	symbol?: {
		id: string;
		kind: string;
		name?: string;
		qualifiedName?: string;
		signature?: string;
		range: SourceRange;
	};
	range?: SourceRange;
	score: number;
	confidence: number;
	reasons: RepoMapMatchReason[];
	relatedEdges: RepoMapRelatedEdge[];
}

export interface RepoMapQueryResult {
	root: string;
	candidates: RepoMapQueryCandidate[];
}

interface SeedMatch {
	symbol: RepoMapSymbolNode;
	score: number;
	confidence: number;
	reasons: RepoMapMatchReason[];
}

/** 对一个 immutable generation 建立进程内 lookup；不读取源码或文件系统。 */
export class RepoMapQueryIndex {
	readonly #generation: RepoMapGeneration;
	readonly #filesById: ReadonlyMap<string, RepoMapFileRecord>;
	readonly #symbolsById: ReadonlyMap<string, RepoMapSymbolNode>;
	readonly #architectureById: ReadonlyMap<string, RepoMapArchitectureNode>;
	readonly #outgoing: ReadonlyMap<string, RepoMapEdge[]>;
	readonly #incoming: ReadonlyMap<string, RepoMapEdge[]>;

	constructor(generation: RepoMapGeneration) {
		this.#generation = generation;
		this.#filesById = new Map(generation.files.map((file) => [file.id, file]));
		this.#symbolsById = new Map(generation.symbols.map((symbol) => [symbol.id, symbol]));
		this.#architectureById = new Map(generation.architecture.map((node) => [node.id, node]));
		this.#outgoing = groupEdges(generation.edges, (edge) => edge.from);
		this.#incoming = groupEdges(generation.edges, (edge) => edge.to);
	}

	findFiles(query: string): RepoMapQueryCandidate[] {
		const normalized = normalize(query);
		const basename = path.posix.basename(normalized);
		const result: RepoMapQueryCandidate[] = [];
		for (const file of this.#generation.files) {
			const filePath = normalize(file.path);
			const fileBasename = path.posix.basename(filePath);
			let score = 0;
			let reason: RepoMapMatchReason | undefined;
			if (filePath === normalized) {
				score = 1_000;
				reason = "exact path";
			} else if (fileBasename === basename || fileBasename === normalized) {
				score = 920;
				reason = "exact filename";
			} else if (filePath.includes(normalized) || fileBasename.includes(normalized)) {
				score = 620;
				reason = "path match";
			}
			if (reason !== undefined) result.push(fileCandidate(file, score, score >= 900 ? 1 : 0.75, [reason]));
		}
		return result.sort(compareCandidates);
	}

	findSymbols(query: string): RepoMapQueryCandidate[] {
		return this.#seedSymbols(query).flatMap((seed) => {
			const file = this.#filesById.get(seed.symbol.fileId);
			return file === undefined ? [] : [symbolCandidate(file, seed.symbol, seed.score, seed.confidence, seed.reasons, [])];
		}).sort(compareCandidates);
	}

	definitions(query: string): RepoMapQueryCandidate[] {
		return this.#seedSymbols(query).flatMap((seed) => this.#definitionCandidate(seed)).sort(compareCandidates);
	}

	references(query: string): RepoMapQueryCandidate[] {
		return this.#incomingSymbolRelations(query, "references", "reference", 430);
	}

	callers(query: string): RepoMapQueryCandidate[] {
		return this.#incomingSymbolRelations(query, "calls", "caller", 460);
	}

	callees(query: string): RepoMapQueryCandidate[] {
		return this.#outgoingSymbolRelations(query, "calls", "callee", 410);
	}

	imports(query: string): RepoMapQueryCandidate[] {
		const result: RepoMapQueryCandidate[] = [];
		for (const seed of this.#seedSymbols(query)) {
			for (const edge of [
				...(this.#outgoing.get(seed.symbol.fileId) ?? []),
				...(this.#incoming.get(seed.symbol.fileId) ?? []),
			]) {
				if (edge.kind !== "imports") continue;
				const relatedFileId = edge.from === seed.symbol.fileId ? edge.to : edge.from;
				const file = this.#filesById.get(relatedFileId);
				if (file === undefined) continue;
			result.push(fileCandidate(file, 260, edge.confidence, ["import"], [edgeDetails(edge, this.#filesById, this.#symbolsById, this.#architectureById)]));
			}
		}
		return coalesceCandidates(result);
	}

	architecture(query: string): RepoMapQueryCandidate[] {
		const normalized = normalize(query);
		if (normalized.length === 0) return [];
		const result: RepoMapQueryCandidate[] = [];
		for (const node of this.#architectureById.values()) {
			const fields = node.kind === "entrypoint"
				? [node.name, node.entrypointType, node.declaredTarget]
				: [node.name, node.rootPath];
			const exact = fields.some((field) => field !== undefined && normalize(field) === normalized);
			const partial = fields.some((field) => field !== undefined && normalize(field).includes(normalized));
			if (!exact && !partial) continue;
			const reason: RepoMapMatchReason = node.kind === "entrypoint"
				? node.entrypointType === "command" || node.entrypointType === "tool" || node.entrypointType === "plugin" ? "registration" : "entrypoint"
				: node.kind;
			const score = (exact ? 820 : 560) + (node.kind === "entrypoint" ? 80 : 0);
			const relations = [...(this.#outgoing.get(node.id) ?? []), ...(this.#incoming.get(node.id) ?? [])];
			const fileIds = new Set<string>();
			if (node.kind === "entrypoint" && node.fileId !== undefined) fileIds.add(node.fileId);
			for (const relation of relations) {
				if (this.#filesById.has(relation.from)) fileIds.add(relation.from);
				if (this.#filesById.has(relation.to)) fileIds.add(relation.to);
				const symbol = this.#symbolsById.get(relation.from);
				if (symbol !== undefined) fileIds.add(symbol.fileId);
			}
			for (const fileId of fileIds) {
				const file = this.#filesById.get(fileId);
				if (file === undefined) continue;
				const relevant = relations.filter((relation) => edgeTouchesFile(relation, fileId, this.#symbolsById, this.#architectureById)).slice(0, 4);
				result.push(fileCandidate(file, score, node.confidence, [reason], relevant.map((relation) => edgeDetails(relation, this.#filesById, this.#symbolsById, this.#architectureById))));
			}
		}
		return coalesceCandidates(result);
	}

	/** 合并 direct、definition 与一跳关系；关系候选不会再次作为扩展种子。 */
	candidates(query: string, limit = 100): RepoMapQueryResult {
		const combined = coalesceCandidates([
			...this.findFiles(query),
			...this.findSymbols(query),
			...this.definitions(query),
			...this.references(query),
			...this.callers(query),
			...this.callees(query),
			...this.imports(query),
			...this.architecture(query),
		]);
		return { root: this.#generation.metadata.repositoryRoot, candidates: combined.slice(0, Math.max(0, limit)) };
	}

	#seedSymbols(query: string): SeedMatch[] {
		const queryLower = query.toLocaleLowerCase();
		const shortQuery = lastSegment(queryLower);
		const result: SeedMatch[] = [];
		for (const symbol of this.#generation.symbols) {
			const name = symbol.name?.toLocaleLowerCase();
			const qualifiedName = symbol.qualifiedName?.toLocaleLowerCase();
			const signature = symbol.signature?.toLocaleLowerCase();
			if (qualifiedName === queryLower) {
				result.push({ symbol, score: 980, confidence: 1, reasons: ["exact qualified symbol", ...(symbol.visibility === "public" ? ["public api" as const] : [])] });
			} else if (name === queryLower) {
				result.push({ symbol, score: 930, confidence: 1, reasons: ["exact symbol", ...(symbol.visibility === "public" ? ["public api" as const] : [])] });
			} else if (qualifiedName !== undefined && lastSegment(qualifiedName) === shortQuery) {
				result.push({ symbol, score: 880, confidence: 0.92, reasons: ["short symbol"] });
			} else if (signature?.includes(queryLower) === true) {
				result.push({ symbol, score: 680, confidence: 0.75, reasons: ["signature"] });
			}
		}
		return result.sort((left, right) => right.score - left.score || compare(left.symbol.id, right.symbol.id));
	}

	#definitionCandidate(seed: SeedMatch): RepoMapQueryCandidate[] {
		const file = this.#filesById.get(seed.symbol.fileId);
		if (file === undefined) return [];
		const exportEdge = (this.#incoming.get(seed.symbol.id) ?? []).find((edge) => edge.kind === "exports" || edge.kind === "exports-publicly");
		return [symbolCandidate(
			file,
			seed.symbol,
			seed.score - 40 + (exportEdge === undefined ? 0 : 35),
			exportEdge?.confidence ?? seed.confidence,
			["definition", ...(seed.symbol.visibility === "public" ? ["public api" as const] : []), ...(exportEdge === undefined ? [] : ["export" as const])],
			exportEdge === undefined ? [] : [edgeDetails(exportEdge, this.#filesById, this.#symbolsById, this.#architectureById)],
		)];
	}

	#incomingSymbolRelations(query: string, kind: "references" | "calls", reason: "reference" | "caller", score: number): RepoMapQueryCandidate[] {
		const result: RepoMapQueryCandidate[] = [];
		for (const seed of this.#seedSymbols(query)) {
			for (const edge of this.#incoming.get(seed.symbol.id) ?? []) {
				if (edge.kind !== kind) continue;
				const source = this.#symbolsById.get(edge.from);
				const file = source === undefined ? undefined : this.#filesById.get(source.fileId);
				if (source === undefined || file === undefined) continue;
				result.push(symbolCandidate(file, source, score, edge.confidence, [reason], [edgeDetails(edge, this.#filesById, this.#symbolsById, this.#architectureById)]));
			}
		}
		return coalesceCandidates(result);
	}

	#outgoingSymbolRelations(query: string, kind: "references" | "calls", reason: "reference" | "callee", score: number): RepoMapQueryCandidate[] {
		const result: RepoMapQueryCandidate[] = [];
		for (const seed of this.#seedSymbols(query)) {
			for (const edge of this.#outgoing.get(seed.symbol.id) ?? []) {
				if (edge.kind !== kind) continue;
				const target = this.#symbolsById.get(edge.to);
				const file = target === undefined ? undefined : this.#filesById.get(target.fileId);
				if (target === undefined || file === undefined) continue;
				result.push(symbolCandidate(file, target, score, edge.confidence, [reason], [edgeDetails(edge, this.#filesById, this.#symbolsById, this.#architectureById)]));
			}
		}
		return coalesceCandidates(result);
	}
}

function fileCandidate(
	file: RepoMapFileRecord,
	score: number,
	confidence: number,
	reasons: RepoMapMatchReason[],
	relatedEdges: RepoMapRelatedEdge[] = [],
): RepoMapQueryCandidate {
	return {
		path: file.path,
		fileId: file.id,
		...(file.contentHash !== undefined ? { contentHash: file.contentHash } : {}),
		score,
		confidence,
		reasons,
		relatedEdges,
	};
}

function symbolCandidate(
	file: RepoMapFileRecord,
	symbol: RepoMapSymbolNode,
	score: number,
	confidence: number,
	reasons: RepoMapMatchReason[],
	relatedEdges: RepoMapRelatedEdge[],
): RepoMapQueryCandidate {
	return {
		...fileCandidate(file, score, confidence, reasons, relatedEdges),
		symbol: {
			id: symbol.id,
			kind: symbol.symbolKind,
			...(symbol.name !== undefined ? { name: symbol.name } : {}),
			...(symbol.qualifiedName !== undefined ? { qualifiedName: symbol.qualifiedName } : {}),
			...(symbol.signature !== undefined ? { signature: symbol.signature } : {}),
			range: range(symbol),
		},
		range: range(symbol),
	};
}

function edgeDetails(
	edge: RepoMapEdge,
	filesById: ReadonlyMap<string, RepoMapFileRecord>,
	symbolsById: ReadonlyMap<string, RepoMapSymbolNode>,
	architectureById: ReadonlyMap<string, RepoMapArchitectureNode>,
): RepoMapRelatedEdge {
	const relatedFiles = [edge.from, edge.to]
		.map((id) => filesById.get(id) ?? filesById.get(symbolsById.get(id)?.fileId ?? "") ?? fileForArchitecture(id, architectureById, filesById))
		.concat(edge.evidence.flatMap((evidence) => [...filesById.values()].find((file) => file.path === evidence.path) ?? []))
		.filter((file): file is RepoMapFileRecord => file !== undefined)
		.filter((file, index, files) => files.findIndex((item) => item.id === file.id) === index)
		.map((file) => ({ path: file.path, ...(file.contentHash !== undefined ? { contentHash: file.contentHash } : {}) }));
	return {
		kind: edge.kind,
		from: edge.from,
		to: edge.to,
		confidence: edge.confidence,
		resolution: edge.resolution,
		source: edge.source,
		evidence: edge.evidence,
		relatedFiles,
	};
}

function fileForArchitecture(
	id: string,
	architectureById: ReadonlyMap<string, RepoMapArchitectureNode>,
	filesById: ReadonlyMap<string, RepoMapFileRecord>,
): RepoMapFileRecord | undefined {
	const node = architectureById.get(id);
	return node?.kind === "entrypoint" && node.fileId !== undefined ? filesById.get(node.fileId) : undefined;
}

function edgeTouchesFile(
	edge: RepoMapEdge,
	fileId: string,
	symbolsById: ReadonlyMap<string, RepoMapSymbolNode>,
	architectureById: ReadonlyMap<string, RepoMapArchitectureNode>,
): boolean {
	const fromNode = architectureById.get(edge.from);
	const toNode = architectureById.get(edge.to);
	return edge.from === fileId || edge.to === fileId
		|| symbolsById.get(edge.from)?.fileId === fileId
		|| symbolsById.get(edge.to)?.fileId === fileId
		|| (fromNode?.kind === "entrypoint" && fromNode.fileId === fileId)
		|| (toNode?.kind === "entrypoint" && toNode.fileId === fileId);
}

function range(value: SourceRange): SourceRange {
	return { startLine: value.startLine, endLine: value.endLine, startByte: value.startByte, endByte: value.endByte };
}

function groupEdges(edges: readonly RepoMapEdge[], key: (edge: RepoMapEdge) => string): ReadonlyMap<string, RepoMapEdge[]> {
	const result = new Map<string, RepoMapEdge[]>();
	for (const edge of edges) {
		const group = result.get(key(edge)) ?? [];
		group.push(edge);
		result.set(key(edge), group);
	}
	return result;
}

function coalesceCandidates(candidates: readonly RepoMapQueryCandidate[]): RepoMapQueryCandidate[] {
	const result = new Map<string, RepoMapQueryCandidate>();
	for (const candidate of candidates) {
		const key = candidate.symbol?.id ?? `${candidate.fileId}:${candidate.range?.startByte ?? "file"}`;
		const existing = result.get(key);
		if (existing === undefined) {
			result.set(key, { ...candidate, reasons: [...candidate.reasons], relatedEdges: [...candidate.relatedEdges] });
			continue;
		}
		existing.score = Math.max(existing.score, candidate.score);
		existing.confidence = Math.max(existing.confidence, candidate.confidence);
		for (const reason of candidate.reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
		for (const edge of candidate.relatedEdges) {
			if (!existing.relatedEdges.some((item) => item.kind === edge.kind && item.from === edge.from && item.to === edge.to)) existing.relatedEdges.push(edge);
		}
	}
	return [...result.values()].sort(compareCandidates);
}

function compareCandidates(left: RepoMapQueryCandidate, right: RepoMapQueryCandidate): number {
	return right.score - left.score || right.confidence - left.confidence || compare(left.path, right.path) || (left.range?.startByte ?? 0) - (right.range?.startByte ?? 0);
}

function normalize(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//u, "").toLocaleLowerCase();
}

function lastSegment(value: string): string {
	return value.split(/[.#]/u).at(-1) ?? value;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
