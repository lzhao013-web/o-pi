import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { safeProjectRequested, type DefinedToolTelemetry } from "./adapter.js";
import { createManifest, manifestValueFingerprint, safeManifestValue, type TelemetryManifest } from "./manifest.js";
import { sourceBundleDescriptor, type SourceReference } from "./source-identity.js";
import type { InputProjection, JsonObject, ToolIdentity } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface ToolIdentityOptions {
	/** Behavior source root. Use import.meta.url; pass multiple roots only for split runtimes. */
	source: SourceReference | readonly SourceReference[];
	/** Effective behavior-affecting configuration. Raw secrets are redacted in its manifest. */
	config?: (ctx: ExtensionContext) => unknown | Promise<unknown>;
}

export interface ResolvedToolIdentity {
	identity: ToolIdentity;
	manifests: TelemetryManifest[];
	config_capture_failed: boolean;
}

interface RegisteredIdentity {
	behavior: TelemetryManifest;
	definition: TelemetryManifest;
	instrumentation: TelemetryManifest;
	coreDefinitionHash: string;
	modelDefinition: unknown;
	projectRequested: (value: unknown) => { value: InputProjection; failed: boolean; limited: boolean };
	loadConfig?: ToolIdentityOptions["config"];
}

const registered = new Map<string, RegisteredIdentity>();

export function registerToolIdentity<TParams extends TSchema, TDetails, TState, TExecuted>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	telemetry: DefinedToolTelemetry<TExecuted, TDetails>,
	options: ToolIdentityOptions,
	repair: unknown,
): void {
	const definition = definitionManifest(tool);
	registered.set(tool.name, {
		behavior: behaviorManifest(tool, sourceReferences(options.source), repair, definition.hash),
		definition,
		instrumentation: instrumentationManifest(tool.name, telemetry),
		coreDefinitionHash: coreDefinitionManifest(tool).hash,
		modelDefinition: modelDefinitionValue(tool),
		projectRequested: (value) => safeProjectRequested(telemetry, value),
		...(options.config === undefined ? {} : { loadConfig: options.config }),
	});
}

export function projectRequestedInput(
	name: string,
	instrumentationHash: string,
	value: unknown,
): { value: InputProjection; failed: boolean; limited: boolean } {
	const identity = registered.get(name);
	return identity === undefined || identity.instrumentation.hash !== instrumentationHash
		? { value: { value: {} }, failed: false, limited: false }
		: identity.projectRequested(value);
}

export async function resolveToolIdentity(tool: ToolInfo | undefined, name: string, ctx: ExtensionContext): Promise<ResolvedToolIdentity> {
	const fallbackDefinition = coreDefinitionManifest(tool ?? { name });
	const registeredIdentity = registered.get(name);
	if (registeredIdentity === undefined || registeredIdentity.coreDefinitionHash !== fallbackDefinition.hash) {
		const fallbackBehavior = createManifest("tool_behavior", {
			tool_name: name,
			definition_hash: fallbackDefinition.hash,
			implementation: "host_unavailable",
		});
		return {
			identity: {
				behavior_hash: fallbackBehavior.hash,
				definition_hash: fallbackDefinition.hash,
				telemetry_hash: "unavailable",
				config_hash: "unavailable",
			},
			manifests: [fallbackDefinition, fallbackBehavior],
			config_capture_failed: false,
		};
	}
	let config: unknown = null;
	let configCaptureFailed = false;
	try {
		config = registeredIdentity.loadConfig === undefined ? null : await registeredIdentity.loadConfig(ctx);
	} catch {
		configCaptureFailed = true;
		config = { capture_failed: true };
	}
	const configManifest = createManifest("tool_config", {
		tool_name: name,
		capture_failed: configCaptureFailed,
		value_fingerprint: manifestValueFingerprint(config),
		value: safeManifestValue(config),
	});
	return {
		identity: {
			behavior_hash: registeredIdentity.behavior.hash,
			definition_hash: registeredIdentity.definition.hash,
			telemetry_hash: registeredIdentity.instrumentation.hash,
			config_hash: configManifest.hash,
		},
		manifests: [registeredIdentity.behavior, registeredIdentity.definition, registeredIdentity.instrumentation, configManifest],
		config_capture_failed: configCaptureFailed,
	};
}

/** Exact model-visible definition captured at registration, with ToolInfo as a fallback for host tools. */
export function toolDefinitionValue(tool: ToolInfo | undefined, name: string): unknown {
	const fallback = coreDefinitionManifest(tool ?? { name });
	const candidate = registered.get(name);
	return candidate !== undefined && candidate.coreDefinitionHash === fallback.hash
		? candidate.modelDefinition
		: modelDefinitionValue(tool ?? { name });
}

export function computeToolBehaviorHash<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	entrypoints: readonly SourceReference[],
	repair: unknown,
): string {
	return behaviorManifest(tool, entrypoints, repair, definitionManifest(tool).hash).hash;
}

export function computeTelemetryHash<TParams, TDetails>(
	telemetry: DefinedToolTelemetry<TParams, TDetails>,
): string {
	return instrumentationManifest("unknown", telemetry).hash;
}

export function computeToolDefinitionHash(tool: Pick<ToolInfo, "name"> & Partial<ToolInfo>): string {
	return coreDefinitionManifest(tool).hash;
}

function behaviorManifest<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	entrypoints: readonly SourceReference[],
	repair: unknown,
	definitionHash: string,
): TelemetryManifest {
	return createManifest("tool_behavior", {
		tool_name: tool.name,
		definition_hash: definitionHash,
		sources: sourceDescriptors([...entrypoints, "src/tool-repair/repair.ts"]),
		repair: safeManifestValue(repair),
		repair_fingerprint: manifestValueFingerprint(repair),
		execution_mode: tool.executionMode ?? "default",
	});
}

function definitionManifest<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>): TelemetryManifest {
	return createManifest("tool_definition", {
		name: tool.name,
		description: safeManifestValue(tool.description),
		description_fingerprint: manifestValueFingerprint(tool.description),
		parameters: safeManifestValue(tool.parameters),
		parameters_fingerprint: manifestValueFingerprint(tool.parameters),
		...(tool.promptSnippet === undefined ? {} : { prompt_snippet: safeManifestValue(tool.promptSnippet),
			prompt_snippet_fingerprint: manifestValueFingerprint(tool.promptSnippet) }),
		...(tool.promptGuidelines === undefined ? {} : { prompt_guidelines: safeManifestValue(tool.promptGuidelines),
			prompt_guidelines_fingerprint: manifestValueFingerprint(tool.promptGuidelines) }),
	});
}

function coreDefinitionManifest(tool: Pick<ToolInfo, "name"> & Partial<ToolInfo>): TelemetryManifest {
	return createManifest("tool_definition", {
		name: tool.name,
		...(tool.description === undefined ? {} : { description: safeManifestValue(tool.description),
			description_fingerprint: manifestValueFingerprint(tool.description) }),
		...(tool.parameters === undefined ? {} : { parameters: safeManifestValue(tool.parameters),
			parameters_fingerprint: manifestValueFingerprint(tool.parameters) }),
		...(tool.promptGuidelines === undefined ? {} : { prompt_guidelines: safeManifestValue(tool.promptGuidelines),
			prompt_guidelines_fingerprint: manifestValueFingerprint(tool.promptGuidelines) }),
	});
}

function modelDefinitionValue(tool: {
	name: string;
	description?: unknown;
	parameters?: unknown;
	promptSnippet?: unknown;
	promptGuidelines?: unknown;
}): unknown {
	return {
		name: tool.name,
		...(tool.description === undefined ? {} : { description: tool.description }),
		...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
		...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
		...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
	};
}

function instrumentationManifest<TParams, TDetails>(
	toolName: string,
	telemetry: DefinedToolTelemetry<TParams, TDetails>,
): TelemetryManifest {
	return createManifest("tool_instrumentation", {
		tool_name: toolName,
		sources: sourceDescriptors(telemetry.sources),
		capabilities: {
			requested_projection: telemetry.requested !== undefined || telemetry.input !== undefined,
			executed_projection: telemetry.executed !== undefined || telemetry.input !== undefined,
			result_observation: telemetry.result !== undefined,
		},
	});
}

function sourceDescriptors(entrypoints: readonly SourceReference[]): JsonObject {
	return sourceBundleDescriptor(entrypoints);
}

function sourceReferences(value: SourceReference | readonly SourceReference[]): readonly SourceReference[] {
	return typeof value === "string" || value instanceof URL ? [value] : value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
