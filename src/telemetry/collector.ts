import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

import { computeRepoMapActivation } from "../repo-map/activation.js";
import { countTextTokensSync } from "../token-counter.js";
import { decodeTelemetryRuntimeEvent, TELEMETRY_RUNTIME_CHANNEL } from "./channel.js";
import { readTelemetryJsonlFile, type TelemetryJsonlSnapshot } from "./jsonl-reader.js";
import { stableHash } from "./projectors.js";
import { assembleToolCallRecord, type ActiveTurn, type ToolCallData, type ToolResultData } from "./record.js";
import { TelemetryCallStore } from "./runtime.js";
import { SessionTelemetryStore } from "./session-store.js";
import type { TelemetryBase, TelemetryContext } from "./types.js";
import { JsonlTelemetryWriter, telemetrySessionFile, type TelemetryWriter, type TelemetryWriterStatus } from "./writer.js";

interface ToolExecutionStartData {
	toolCallId: string;
	toolName: string;
}

export interface TelemetryCollectorOptions {
	now?: () => Date;
	writerFactory?: (sessionId: string) => TelemetryWriter;
	sessionLoader?: (sessionId: string) => Promise<TelemetryJsonlSnapshot>;
}

export interface TelemetryCollectorSnapshot {
	sessionId?: string;
	records: readonly unknown[];
	revision: number;
	invalidLines: number;
	lastCompletedTurn?: number;
	inProgressCalls: number;
	writer: TelemetryWriterStatus;
}

export class TelemetryCollector {
	readonly #now: () => Date;
	readonly #writerFactory: (sessionId: string) => TelemetryWriter;
	readonly #sessionLoader: (sessionId: string) => Promise<TelemetryJsonlSnapshot>;
	readonly #callStore = new TelemetryCallStore();
	#sessionStore: SessionTelemetryStore | undefined;
	#writer: TelemetryWriter | undefined;
	#sessionId: string | undefined;
	#turn: ActiveTurn | undefined;
	#context: TelemetryContext = { cwd: "unknown" };
	#sequence = 0;
	#lastCompletedTurn: number | undefined;
	readonly #definitionCache = new Map<string, Array<{ name: string; estimated_tokens: number }>>();

	constructor(options: TelemetryCollectorOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#writerFactory = options.writerFactory ?? ((sessionId) => new JsonlTelemetryWriter(sessionId));
		this.#sessionLoader = options.sessionLoader ?? ((sessionId) => readTelemetryJsonlFile(telemetrySessionFile(sessionId)));
	}

	async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		try {
			await this.#writer?.flush();
			const sessionId = ctx.sessionManager.getSessionId();
			let historical: TelemetryJsonlSnapshot = { records: [], invalidLines: 0 };
			try {
				historical = await this.#sessionLoader(sessionId);
			} catch {
				// A failed hydration starts a live-only view without affecting the session.
			}
			this.#sessionId = sessionId;
			this.#writer = this.#writerFactory(sessionId);
			this.#sessionStore = new SessionTelemetryStore(sessionId, historical.records, historical.invalidLines);
			this.#context = { cwd: ctx.cwd };
			this.#turn = undefined;
			this.#callStore.reset();
			this.#sequence = nextSequence(historical.records, sessionId);
			this.#lastCompletedTurn = latestCompletedTurn(historical.records, sessionId);
			this.append({ event: "session_start", ...this.base(this.#context), data: { reason: event.reason } });
		} catch {
			// Collection and hydration must never affect session startup.
		}
	}

	onTurnStart(event: TurnStartEvent, ctx: ExtensionContext, pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel">): void {
		this.guard(() => {
			const activeTools = [...pi.getActiveTools()].sort();
			const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
			const toolset = activeTools.map((name) => {
				const tool = toolsByName.get(name);
				return tool === undefined ? { name } : {
					name,
					description: tool.description,
					parameters: tool.parameters,
					...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
				};
			});
			const toolsetHash = stableHash(toolset);
			const modelKey = ctx.model === undefined ? "unknown" : `${ctx.model.provider}/${ctx.model.id}`;
			const cacheKey = `${modelKey}\0${toolsetHash}`;
			let toolDefinitions = this.#definitionCache.get(cacheKey);
			if (toolDefinitions === undefined) {
				toolDefinitions = toolset.map((tool) => ({
					name: tool.name,
					estimated_tokens: countTextTokensSync(JSON.stringify(tool), ctx.model === undefined ? {} : {
						provider: ctx.model.provider,
						modelId: ctx.model.id,
					}).tokens,
				}));
				this.#definitionCache.set(cacheKey, toolDefinitions);
			}
			const id = `${this.#sessionId ?? "unknown"}:${event.turnIndex}:${event.timestamp}`;
			const context: TelemetryContext = {
				cwd: ctx.cwd,
				...(ctx.model === undefined ? {} : { model: { provider: ctx.model.provider, id: ctx.model.id } }),
				thinking_level: pi.getThinkingLevel(),
				toolset_hash: toolsetHash,
			};
			this.#context = context;
			this.#turn = { id, index: event.turnIndex, startedAt: this.#now().getTime(), context };
			const activation = computeRepoMapActivation(ctx.sessionManager.getBranch());
			this.append({
				event: "turn_start",
				...this.base(context),
				turn_id: id,
				data: {
					turn_index: event.turnIndex,
					active_tools: activeTools,
					toolset_hash: toolsetHash,
					tool_definitions: toolDefinitions,
					repo_map: activation === undefined
						? { enabled: false }
						: { enabled: true, freshness: activation.freshness ?? "fresh", map_id: activation.mapId },
				},
			});
		});
	}

	onToolExecutionStart(event: ToolExecutionStartData): void {
		this.guard(() => this.#callStore.start(event.toolCallId, event.toolName));
	}

	onRuntimeEvent(value: unknown): void {
		this.guard(() => {
			const event = decodeTelemetryRuntimeEvent(value);
			if (event !== undefined) this.#callStore.apply(event);
		});
	}

	onTurnEnd(event: TurnEndEvent): void {
		this.guard(() => {
			const turn = this.#turn ?? {
				id: `${this.#sessionId ?? "unknown"}:${event.turnIndex}:unknown`,
				index: event.turnIndex,
				startedAt: this.#now().getTime(),
				context: this.#context,
			};
			const calls = toolCalls(event);
			const results = toolResults(event);
			for (const call of calls) {
				try {
					this.append(assembleToolCallRecord(this.base(turn.context), turn, call, results.get(call.id), this.#callStore));
				} catch {
					// A malformed call must not suppress later calls or turn_end.
				}
			}
			this.append({
				event: "turn_end",
				...this.base(turn.context),
				turn_id: turn.id,
				data: {
					turn_index: turn.index,
					tool_calls: calls.length,
					duration_ms: Math.max(0, this.#now().getTime() - turn.startedAt),
				},
			});
			this.#lastCompletedTurn = turn.index;
			this.#turn = undefined;
			this.#callStore.reset();
		});
	}

	async onSessionShutdown(event: SessionShutdownEvent): Promise<void> {
		try {
			this.append({ event: "session_end", ...this.base(this.#context), data: { reason: event.reason } });
			await this.#writer?.flush();
		} catch {
			// Writer failures are deliberately invisible to the agent lifecycle.
		} finally {
			this.#callStore.reset();
		}
	}

	snapshot(): TelemetryCollectorSnapshot {
		const session = this.#sessionStore?.snapshot();
		const writer = this.#writer?.status?.() ?? emptyWriterStatus();
		return {
			...(session === undefined ? {} : { sessionId: session.sessionId }),
			records: session?.records ?? [],
			revision: session?.revision ?? 0,
			invalidLines: session?.invalidLines ?? 0,
			...(this.#lastCompletedTurn === undefined ? {} : { lastCompletedTurn: this.#lastCompletedTurn }),
			inProgressCalls: this.#callStore.size,
			writer,
		};
	}

	private base(context: TelemetryContext): TelemetryBase {
		return {
			id: randomUUID(),
			timestamp: this.#now().toISOString(),
			session_id: this.#sessionId ?? "unknown",
			sequence: this.#sequence++,
			context,
		};
	}

	private append(record: Parameters<TelemetryWriter["append"]>[0]): void {
		this.#sessionStore?.append(record);
		try {
			this.#writer?.append(record);
		} catch {
			// Custom/test writers receive the same best-effort boundary as the JSONL writer.
		}
	}

	private guard(action: () => void): void {
		try {
			action();
		} catch {
			// Collection must never affect Pi event handling.
		}
	}
}

function emptyWriterStatus(): TelemetryWriterStatus {
	return { pending: 0, persisted: 0, failed: 0 };
}

function nextSequence(records: readonly unknown[], sessionId: string): number {
	let maximum = -1;
	for (const record of records) {
		if (!isRecord(record) || record["session_id"] !== sessionId) continue;
		const sequence = record["sequence"];
		if (typeof sequence === "number" && Number.isInteger(sequence)) maximum = Math.max(maximum, sequence);
	}
	return maximum + 1;
}

function latestCompletedTurn(records: readonly unknown[], sessionId: string): number | undefined {
	let latest: number | undefined;
	for (const record of records) {
		if (!isRecord(record) || record["session_id"] !== sessionId || record["event"] !== "turn_end") continue;
		const data = record["data"];
		if (!isRecord(data) || typeof data["turn_index"] !== "number") continue;
		latest = data["turn_index"];
	}
	return latest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerTelemetry(
	pi: Pick<ExtensionAPI, "events" | "getActiveTools" | "getAllTools" | "getThinkingLevel" | "on">,
	options: TelemetryCollectorOptions = {},
): TelemetryCollector {
	const collector = new TelemetryCollector(options);
	const disposeRuntime = pi.events.on(TELEMETRY_RUNTIME_CHANNEL, (value) => collector.onRuntimeEvent(value));
	pi.on("session_start", (event, ctx) => collector.onSessionStart(event, ctx));
	pi.on("turn_start", (event, ctx) => collector.onTurnStart(event, ctx, pi));
	pi.on("tool_execution_start", (event) => collector.onToolExecutionStart(event));
	pi.on("turn_end", (event) => collector.onTurnEnd(event));
	pi.on("session_shutdown", async (event) => {
		await collector.onSessionShutdown(event);
		if (event.reason === "reload" || event.reason === "quit") disposeRuntime();
	});
	return collector;
}

function toolCalls(event: TurnEndEvent): ToolCallData[] {
	if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return [];
	return event.message.content.flatMap((part) => part.type === "toolCall"
		? [{ id: part.id, name: part.name }]
		: []);
}

function toolResults(event: TurnEndEvent): Map<string, ToolResultData> {
	return new Map(event.toolResults.map((result) => [result.toolCallId, {
		content: result.content,
		details: result.details,
		isError: result.isError,
	}]));
}
