import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import type { ToolTelemetryAdapter } from "./adapter.js";
import { stableHash } from "./projectors.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/gu;
const COHORT_FORMAT = 1;

export interface ToolCohortSpec {
	/** Repository-relative implementation and telemetry entrypoints for this tool. */
	implementationEntrypoints: readonly string[];
	/** Effective behavior-affecting configuration. The value itself is never persisted. */
	config?: (ctx: ExtensionContext) => unknown | Promise<unknown>;
}

type CohortAPI = Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel">;

export function computeToolImplementationHash<TParams extends TSchema, TDetails, TState, TExecuted>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	telemetry: ToolTelemetryAdapter<TExecuted, TDetails>,
	entrypoints: readonly string[],
	repair: unknown,
): string {
	return stableHash({
		sources: sourceGraph([...entrypoints, "src/tool-repair/repair.ts"]),
		definition: {
			name: tool.name,
			description: tool.description,
			promptSnippet: tool.promptSnippet,
			promptGuidelines: tool.promptGuidelines,
			parameters: tool.parameters,
			executionMode: tool.executionMode,
			execute: String(tool.execute),
		},
		telemetry: {
			projectRequested: String(telemetry.projectRequested),
			projectExecuted: String(telemetry.projectExecuted),
			observeResult: String(telemetry.observeResult),
		},
		repair,
	});
}

export async function computeToolCohortId(
	pi: CohortAPI,
	ctx: ExtensionContext,
	toolImplementationHash: string,
	loadConfig: ToolCohortSpec["config"],
): Promise<string> {
	let config: unknown = null;
	try {
		config = loadConfig === undefined ? null : await loadConfig(ctx);
	} catch {
		config = { unavailable: true };
	}
	const activeTools = typeof pi.getActiveTools === "function" ? [...pi.getActiveTools()].sort() : [];
	const definitions = new Map(typeof pi.getAllTools === "function" ? pi.getAllTools().map((tool) => [tool.name, tool]) : []);
	const toolset = activeTools.map((name) => {
		const tool = definitions.get(name);
		return tool === undefined ? { name } : {
			name,
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines,
		};
	});
	return stableHash({
		format: COHORT_FORMAT,
		pi_version: piVersion(),
		tool_implementation_hash: toolImplementationHash,
		tool_config_hash: stableHash(config),
		model: ctx.model === undefined ? null : { provider: ctx.model.provider, id: ctx.model.id },
		thinking_level: typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "unknown",
		toolset_hash: stableHash(toolset),
	});
}

function sourceGraph(entrypoints: readonly string[]): Array<{ path: string; sha256: string }> {
	const pending = entrypoints.map((entry) => path.resolve(ROOT, entry));
	const visited = new Set<string>();
	const files: Array<{ path: string; sha256: string }> = [];
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || visited.has(file)) continue;
		visited.add(file);
		if (!isFileInsideRoot(file)) throw new Error(`Invalid telemetry implementation entrypoint: ${path.relative(ROOT, file)}`);
		const content = readFileSync(file, "utf8");
		files.push({ path: relativePath(file), sha256: sha256(content) });
		for (const specifier of relativeImports(content)) {
			const resolved = resolveSourceImport(file, specifier);
			if (resolved !== undefined && !visited.has(resolved)) pending.push(resolved);
		}
	}
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

function relativeImports(content: string): string[] {
	const imports: string[] = [];
	for (const match of content.matchAll(IMPORT_PATTERN)) {
		const specifier = match[1] ?? match[2];
		if (specifier !== undefined) imports.push(specifier);
	}
	return imports;
}

function resolveSourceImport(importer: string, specifier: string): string | undefined {
	const base = path.resolve(path.dirname(importer), specifier);
	const extension = path.extname(base);
	const candidates = extension === ".js" || extension === ".mjs" || extension === ".cjs"
		? [base.slice(0, -extension.length) + ".ts", base.slice(0, -extension.length) + ".tsx"]
		: extension.length > 0 ? [base] : [base + ".ts", base + ".tsx", path.join(base, "index.ts")];
	return candidates.find(isFileInsideRoot);
}

function isFileInsideRoot(file: string): boolean {
	const relative = path.relative(ROOT, file);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(file)) return false;
	return statSync(file).isFile();
}

let cachedPiVersion: string | undefined;

function piVersion(): string {
	if (cachedPiVersion !== undefined) return cachedPiVersion;
	for (const start of [process.argv[1], path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent")]) {
		if (start === undefined) continue;
		let directory = existsSync(start) && statSync(start).isDirectory() ? start : path.dirname(start);
		while (true) {
			const packageFile = path.join(directory, "package.json");
			if (existsSync(packageFile)) {
				try {
					const parsed: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
					if (isRecord(parsed) && parsed["name"] === "@earendil-works/pi-coding-agent" && typeof parsed["version"] === "string") {
						cachedPiVersion = parsed["version"];
						return cachedPiVersion;
					}
				} catch {
					// Continue searching for the host package.
				}
			}
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	cachedPiVersion = "unknown";
	return cachedPiVersion;
}

function relativePath(file: string): string {
	return path.relative(ROOT, file).replace(/\\/gu, "/");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
