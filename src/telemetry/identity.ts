import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import type { ToolTelemetryAdapter } from "./adapter.js";
import { stableHash } from "./projectors.js";
import type { ToolIdentity } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/gu;
const HASH_FORMAT = 1;

export interface ToolIdentitySpec {
	/** Behavior sources only. Telemetry adapter sources must not be listed here. */
	behaviorEntrypoints: readonly string[];
	/** Adapter and projection sources only. */
	telemetryEntrypoints: readonly string[];
	/** Effective behavior-affecting configuration. The raw value is never persisted. */
	config?: (ctx: ExtensionContext) => unknown | Promise<unknown>;
}

interface RegisteredIdentity {
	behaviorHash: string;
	definitionHash: string;
	telemetryHash: string;
	loadConfig?: ToolIdentitySpec["config"];
}

const registered = new Map<string, RegisteredIdentity>();

export function registerToolIdentity<TParams extends TSchema, TDetails, TState, TExecuted>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	telemetry: ToolTelemetryAdapter<TExecuted, TDetails>,
	spec: ToolIdentitySpec,
	repair: unknown,
): void {
	registered.set(tool.name, {
		behaviorHash: computeToolBehaviorHash(tool, spec.behaviorEntrypoints, repair),
		definitionHash: computeToolDefinitionHash(tool),
		telemetryHash: computeTelemetryHash(telemetry, spec.telemetryEntrypoints),
		...(spec.config === undefined ? {} : { loadConfig: spec.config }),
	});
}

export async function resolveToolIdentity(
	tool: ToolInfo | undefined,
	name: string,
	ctx: ExtensionContext,
): Promise<ToolIdentity> {
	const definitionHash = computeToolDefinitionHash(tool ?? { name });
	const identity = registered.get(name);
	if (identity === undefined || identity.definitionHash !== definitionHash) {
		return {
			behavior_hash: "unavailable",
			definition_hash: definitionHash,
			telemetry_hash: "unavailable",
			config_hash: "unavailable",
		};
	}
	let config: unknown = null;
	try {
		config = identity.loadConfig === undefined ? null : await identity.loadConfig(ctx);
	} catch {
		config = { unavailable: true };
	}
	return {
		behavior_hash: identity.behaviorHash,
		definition_hash: definitionHash,
		telemetry_hash: identity.telemetryHash,
		config_hash: stableHash(config),
	};
}

export function isObservedTool(name: string): boolean {
	return registered.has(name);
}

export function computeToolBehaviorHash<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	entrypoints: readonly string[],
	repair: unknown,
): string {
	return stableHash({
		format: HASH_FORMAT,
		sources: sourceGraph([...entrypoints, "src/tool-repair/repair.ts"]),
		definition: behaviorDefinition(tool),
		repair,
	});
}

export function computeTelemetryHash<TParams, TDetails>(
	telemetry: ToolTelemetryAdapter<TParams, TDetails>,
	entrypoints: readonly string[],
): string {
	return stableHash({
		format: HASH_FORMAT,
		sources: sourceGraph(entrypoints),
		adapter: {
			projectRequested: String(telemetry.projectRequested),
			projectExecuted: String(telemetry.projectExecuted),
			observeResult: String(telemetry.observeResult),
		},
	});
}

export function computeToolDefinitionHash(tool: Pick<ToolInfo, "name"> & Partial<ToolInfo>): string {
	return stableHash({
		format: HASH_FORMAT,
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines,
	});
}

function behaviorDefinition<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>): unknown {
	return {
		name: tool.name,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: tool.parameters,
		executionMode: tool.executionMode,
		execute: String(tool.execute),
	};
}

function sourceGraph(entrypoints: readonly string[]): Array<{ path: string; sha256: string }> {
	const pending = entrypoints.map((entry) => path.resolve(ROOT, entry));
	const visited = new Set<string>();
	const files: Array<{ path: string; sha256: string }> = [];
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || visited.has(file)) continue;
		visited.add(file);
		if (!isFileInsideRoot(file)) throw new Error(`Invalid telemetry identity entrypoint: ${path.relative(ROOT, file)}`);
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

export function piVersion(): string {
	if (cachedPiVersion !== undefined) return cachedPiVersion;
	const packageFile = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
	try {
		const parsed: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
		if (isRecord(parsed) && typeof parsed["version"] === "string") cachedPiVersion = parsed["version"];
	} catch {
		cachedPiVersion = "unknown";
	}
	return cachedPiVersion ?? "unknown";
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
