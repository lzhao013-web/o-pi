import type {
	AgentStartEvent,
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
import { isObservedTool, piVersion, resolveToolIdentity } from "./identity.js";
import { readTelemetryJsonlFile, type TelemetryJsonlSnapshot } from "./jsonl-reader.js";
import { stableHash } from "./projectors.js";
import { assembleToolCallEndRecord, type ActiveTurn } from "./record.js";
import { TelemetryCallStore, type ToolCallState } from "./runtime.js";
import { SessionTelemetryStore } from "./session-store.js";
import type {
	CallDimensions,
	CollectionHealthIssue,
	JsonObject,
	TelemetryBase,
	TelemetryContext,
	TelemetryRecord,
	ToolExposure,
	ToolIdentity,
} from "./types.js";
import {
	JsonlTelemetryWriter,
	telemetryHealthFile,
	telemetrySessionFile,
	type TelemetryWriter,
	type TelemetryWriterStatus,
} from "./writer.js";

interface ToolExecutionStartData {
	toolCallId: string;
	toolName: string;
}

interface MessageEndData {
	message: TurnEndEvent["message"];
}

interface ToolExecutionEndData {
	toolCallId: string;
	toolName: string;
	result: { content: unknown; details: unknown };
	isError: boolean;
}

interface CallPlacement extends CallDimensions {
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
	readonly #placements = new Map<string, CallPlacement>();
	readonly #metricSchemas = new Map<string, string>();
	#sessionStore: SessionTelemetryStore | undefined;
	#writer: TelemetryWriter | undefined;
	#sessionId: string | undefined;
	#turn: ActiveTurn | undefined;
	#context: TelemetryContext = hostContext("unknown");
	#sequence = 0;
	#lastCompletedTurn: number | undefined;
	#interactionId: string | undefined;

	constructor(options: TelemetryCollectorOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#writerFactory = options.writerFactory ?? ((sessionId) => new JsonlTelemetryWriter(sessionId));
		this.#sessionLoader = options.sessionLoader ?? loadTelemetrySession;
	}

	async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		try {
			await this.#writer?.flush();
			const sessionId = ctx.sessionManager.getSessionId();
			let historical: TelemetryJsonlSnapshot = { records: [], invalidLines: 0 };
			try {
				historical = await this.#sessionLoader(sessionId);
			} catch {
				// Hydration is diagnostic-only and must not affect the session.
			}
			this.#sessionId = sessionId;
			this.#writer = this.#writerFactory(sessionId);
			this.#sessionStore = new SessionTelemetryStore(sessionId, historical.records, historical.invalidLines);
			this.#context = contextFor(ctx, undefined, []);
			this.#turn = undefined;
			this.#interactionId = undefined;
			this.#placements.clear();
			this.#metricSchemas.clear();
			this.#callStore.reset();
			this.#sequence = nextSequence(historical.records, sessionId);
			this.#lastCompletedTurn = latestCompletedTurn(historical.records, sessionId);
			this.append({ event: "session_start", ...this.base(this.#context), data: { reason: event.reason } });
			this.recordHistoricalHealth(historical);
		} catch {
			// Collection must never affect session startup.
		}
	}

	onAgentStart(_event: AgentStartEvent): void {
		this.guard(() => {
			this.#interactionId = randomUUID();
		});
	}

	async onTurnStart(
		event: TurnStartEvent,
		ctx: ExtensionContext,
		pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel">,
	): Promise<void> {
		try {
			const activeTools = [...pi.getActiveTools()].sort();
			const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
			const identities = await Promise.all(activeTools.map(async (name) => [
				name,
				await resolveToolIdentity(toolsByName.get(name), name, ctx),
			] as const));
			const exposures = new Map(identities);
			const toolsetValue = activeTools.map((name) => {
				const tool = toolsByName.get(name);
				return tool === undefined ? { name } : definitionValue(tool);
			});
			const context = contextFor(ctx, pi.getThinkingLevel(), toolsetValue);
			const id = `${this.#sessionId ?? "unknown"}:${event.turnIndex}:${event.timestamp}`;
			this.#context = context;
			this.#turn = {
				id,
				index: event.turnIndex,
				startedAt: this.#now().getTime(),
				context,
				exposures,
				startedCallIds: new Set(),
				endedCallIds: new Set(),
				projectionFailureIds: new Set(),
				...(this.#interactionId === undefined ? {} : { interactionId: this.#interactionId }),
			};
			const tools: ToolExposure[] = activeTools.map((name) => {
				const definition = toolsByName.get(name);
				const counted = countTextTokensSync(JSON.stringify(definition === undefined ? { name } : definitionValue(definition)), modelScope(ctx));
				return {
					name,
					...(exposures.get(name) ?? unavailableIdentity()),
					definition_tokens: { value: counted.tokens, method: counted.method },
				};
			});
			const activation = computeRepoMapActivation(safeBranch(ctx));
			this.append({
				event: "turn_start",
				...this.base(context),
				turn_id: id,
				...(this.#interactionId === undefined ? {} : { interaction_id: this.#interactionId }),
				data: {
					turn_index: event.turnIndex,
					tools,
					repo_map: activation === undefined
						? { enabled: false }
						: { enabled: true, freshness: activation.freshness ?? "fresh", map_id: activation.mapId },
				},
			});
		} catch {
			// Turn collection failure does not affect model execution.
		}
	}

	onMessageEnd(event: MessageEndData): void {
		this.guard(() => {
			if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;
			const calls = event.message.content.filter((part) => part.type === "toolCall");
			if (calls.length === 0) return;
			const assistantMessageId = randomUUID();
			const batchId = randomUUID();
			for (const [index, call] of calls.entries()) {
				this.#placements.set(call.id, {
					toolName: call.name,
					assistant_message_id: assistantMessageId,
					tool_batch_id: batchId,
					batch_size: calls.length,
					batch_index: index,
					...(this.#interactionId === undefined ? {} : { interaction_id: this.#interactionId }),
				});
			}
		});
	}

	onToolExecutionStart(event: ToolExecutionStartData): void {
		this.guard(() => {
			const turn = this.requireTurn();
			const candidatePlacement = this.#placements.get(event.toolCallId);
			const placement = candidatePlacement?.toolName === event.toolName ? candidatePlacement : undefined;
			const identity = turn.exposures.get(event.toolName) ?? unavailableIdentity();
			const call = this.#callStore.start({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				turnId: turn.id,
				turnIndex: turn.index,
				identity,
				startedAt: this.#now().getTime(),
				...(placement?.interaction_id === undefined ? {} : { interaction_id: placement.interaction_id }),
				...(placement?.assistant_message_id === undefined ? {} : { assistant_message_id: placement.assistant_message_id }),
				...(placement?.tool_batch_id === undefined ? {} : { tool_batch_id: placement.tool_batch_id }),
				...(placement?.batch_size === undefined ? {} : { batch_size: placement.batch_size }),
				...(placement?.batch_index === undefined ? {} : { batch_index: placement.batch_index }),
			});
			turn.startedCallIds.add(event.toolCallId);
			this.append({
				event: "tool_call_start",
				...this.base(turn.context),
				turn_id: turn.id,
				tool_call_id: event.toolCallId,
				...dimensions(call),
				data: { turn_index: turn.index, tool: { name: event.toolName, identity } },
			});
		});
	}

	onRuntimeEvent(value: unknown): void {
		this.guard(() => {
			const event = decodeTelemetryRuntimeEvent(value);
			if (event === undefined) return;
			const observedAt = this.#now().getTime();
			const call = this.#callStore.apply(event, observedAt);
			if (call === undefined) return;
			if (event.kind === "execute_start") {
				this.append({
					event: "tool_execution_start",
					...this.base(this.contextForCall(call)),
					turn_id: call.turnId,
					tool_call_id: call.toolCallId,
					...dimensions(call),
					data: {
						turn_index: call.turnIndex,
						tool: { name: call.toolName, identity: call.identity },
						input: { requested: call.requested, executed: event.executed },
						...(call.preparation === undefined ? {} : { preparation: call.preparation }),
						...(call.approval === undefined ? {} : { approval: call.approval }),
						...(call.projectionFailed ? { projection_failed: true } : {}),
					},
				});
			}
			if (call.projectionFailed) this.recordProjectionFailure(call);
			if (event.kind === "execute_end" && call.result !== undefined) this.finalizeCall(call, observedAt);
		});
	}

	onToolExecutionEnd(event: ToolExecutionEndData): void {
		this.guard(() => {
			const call = this.#callStore.finish(event.toolCallId, event.toolName, {
				content: event.result.content,
				details: event.result.details,
				isError: event.isError,
			});
			if (call === undefined) return;
			if (!isObservedTool(event.toolName) || call.execute !== undefined || call.preparation?.status === "invalid" || isDenied(call)) {
				this.finalizeCall(call, this.#now().getTime());
			}
		});
	}

	onTurnEnd(event: TurnEndEvent): void {
		this.guard(() => {
			const turn = this.#turn ?? this.requireTurn(event.turnIndex);
			const expectedIds = toolCalls(event).map((call) => call.id);
			for (const id of expectedIds) {
				const call = this.#callStore.get(id);
				if (call?.result !== undefined) this.finalizeCall(call, this.#now().getTime());
			}
			const missingStartIds = expectedIds.filter((id) => !turn.startedCallIds.has(id));
			const allCallIds = new Set([...expectedIds, ...turn.startedCallIds]);
			const missingEndIds = [...allCallIds].filter((id) => !turn.endedCallIds.has(id));
			for (const id of missingStartIds) this.health("missing_start", { turn, toolCallId: id });
			for (const id of missingEndIds) this.health("missing_end", { turn, toolCallId: id });
			this.append({
				event: "turn_end",
				...this.base(turn.context),
				turn_id: turn.id,
				...(turn.interactionId === undefined ? {} : { interaction_id: turn.interactionId }),
				data: {
					turn_index: turn.index,
					duration_ms: Math.max(0, this.#now().getTime() - turn.startedAt),
					expected_call_count: expectedIds.length,
					observed_start_count: turn.startedCallIds.size,
					observed_end_count: turn.endedCallIds.size,
					unfinished_call_count: missingEndIds.length,
					projection_failure_count: turn.projectionFailureIds.size,
					missing_start_ids: missingStartIds,
					missing_end_ids: missingEndIds,
				},
			});
			this.#lastCompletedTurn = turn.index;
			this.#turn = undefined;
			this.#placements.clear();
			for (const call of this.#callStore.forTurn(turn.id)) this.#callStore.take(call.toolCallId);
		});
	}

	async onSessionShutdown(event: SessionShutdownEvent): Promise<void> {
		try {
			const unfinishedTurnId = this.#turn?.id;
			if (this.#turn !== undefined) this.health("unfinished_turn", { turn: this.#turn });
			this.append({
				event: "session_end",
				...this.base(this.#context),
				data: {
					reason: event.reason,
					...(unfinishedTurnId === undefined ? {} : { unfinished_turn_id: unfinishedTurnId }),
					unfinished_call_count: this.#callStore.size,
				},
			});
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

	private finalizeCall(call: ToolCallState, endedAt: number): void {
		if (this.#callStore.get(call.toolCallId) === undefined) return;
		this.enforceMetricSchemas(call);
		const record = assembleToolCallEndRecord(this.base(this.contextForCall(call)), call, endedAt);
		this.append(record);
		this.#turn?.endedCallIds.add(call.toolCallId);
		this.#callStore.take(call.toolCallId);
	}

	private enforceMetricSchemas(call: ToolCallState): void {
		const metrics = call.observation?.metrics;
		if (metrics === undefined) return;
		for (const [name, metric] of Object.entries(metrics)) {
			const schema = stableHash({ kind: metric.kind, aggregation: metric.aggregation, unit: "unit" in metric ? metric.unit : null });
			const previous = this.#metricSchemas.get(name);
			if (previous === undefined) this.#metricSchemas.set(name, schema);
			else if (previous !== schema) {
				delete metrics[name];
				this.health("metric_schema_conflict", { call, details: { metric: name } });
			}
		}
	}

	private recordProjectionFailure(call: ToolCallState): void {
		const turn = this.#turn;
		if (turn?.projectionFailureIds.has(call.toolCallId) === true) return;
		turn?.projectionFailureIds.add(call.toolCallId);
		this.health("projection_failed", { call });
	}

	private recordHistoricalHealth(snapshot: TelemetryJsonlSnapshot): void {
		if (snapshot.invalidLines > 0) this.health("invalid_jsonl", { count: snapshot.invalidLines });
		const sequences = [...new Set(snapshot.records.flatMap((record) => sequenceOf(record, this.#sessionId) ?? []))]
			.sort((left, right) => left - right);
		let gaps = sequences.length > 0 && sequences[0] !== 0 ? 1 : 0;
		for (let index = 1; index < sequences.length; index += 1) {
			if (sequences[index] !== (sequences[index - 1] ?? -1) + 1) gaps += 1;
		}
		if (gaps > 0) this.health("sequence_gap", { count: gaps });
	}

	private health(
		issue: CollectionHealthIssue,
		options: { turn?: ActiveTurn; call?: ToolCallState; toolCallId?: string; count?: number; details?: JsonObject } = {},
	): void {
		const turn = options.turn ?? this.#turn;
		const call = options.call;
		const turnId = turn?.id ?? call?.turnId;
		const toolCallId = options.toolCallId ?? call?.toolCallId;
		this.append({
			event: "collection_health",
			...this.base(turn?.context ?? this.#context),
			...(turnId === undefined ? {} : { turn_id: turnId }),
			...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
			data: {
				issue,
				...(options.count === undefined ? {} : { count: options.count }),
				...(options.details === undefined ? {} : { details: options.details }),
			},
		});
	}

	private requireTurn(index = -1): ActiveTurn {
		if (this.#turn !== undefined) return this.#turn;
		const id = `${this.#sessionId ?? "unknown"}:${index}:unattributed`;
		this.#turn = {
			id,
			index,
			startedAt: this.#now().getTime(),
			context: this.#context,
			exposures: new Map(),
			startedCallIds: new Set(),
			endedCallIds: new Set(),
			projectionFailureIds: new Set(),
		};
		return this.#turn;
	}

	private contextForCall(call: ToolCallState): TelemetryContext {
		return this.#turn?.id === call.turnId ? this.#turn.context : this.#context;
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

	private append(record: TelemetryRecord): void {
		this.#sessionStore?.append(record);
		try {
			this.#writer?.append(record);
		} catch {
			// Custom writers share the same best-effort boundary as the JSONL writer.
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

function contextFor(ctx: ExtensionContext, thinkingLevel: string | undefined, toolset: unknown[]): TelemetryContext {
	const active = toolset.map((item) => isRecord(item) && typeof item["name"] === "string" ? item["name"] : "unknown");
	const branch = safeBranch(ctx);
	const leafId = safeLeafId(ctx);
	return {
		cwd: ctx.cwd,
		...(ctx.model === undefined ? {} : { model: { provider: ctx.model.provider, id: ctx.model.id } }),
		...(thinkingLevel === undefined ? {} : { thinking_level: thinkingLevel }),
		toolset: { active, hash: stableHash(toolset) },
		host: {
			pi_version: piVersion(),
		...(ctx.mode === undefined ? {} : { mode: ctx.mode }),
			platform: process.platform,
			arch: process.arch,
			node_version: process.version,
		},
		branch: {
			...(leafId === null ? {} : { leaf_id: leafId }),
			lineage_hash: stableHash(branch.map((entry) => entry.id)),
			depth: branch.length,
		},
	};
}

function hostContext(cwd: string): TelemetryContext {
	return {
		cwd,
		host: {
			pi_version: piVersion(),
			platform: process.platform,
			arch: process.arch,
			node_version: process.version,
		},
	};
}

function definitionValue(tool: ReturnType<ExtensionAPI["getAllTools"]>[number]) {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
	};
}

function modelScope(ctx: ExtensionContext): { provider?: string; modelId?: string } {
	return ctx.model === undefined ? {} : { provider: ctx.model.provider, modelId: ctx.model.id };
}

function dimensions(call: ToolCallState): CallDimensions {
	return {
		...(call.interaction_id === undefined ? {} : { interaction_id: call.interaction_id }),
		...(call.assistant_message_id === undefined ? {} : { assistant_message_id: call.assistant_message_id }),
		...(call.tool_batch_id === undefined ? {} : { tool_batch_id: call.tool_batch_id }),
		...(call.batch_size === undefined ? {} : { batch_size: call.batch_size }),
		...(call.batch_index === undefined ? {} : { batch_index: call.batch_index }),
	};
}

function unavailableIdentity(): ToolIdentity {
	return {
		behavior_hash: "unavailable",
		definition_hash: "unavailable",
		telemetry_hash: "unavailable",
		config_hash: "unavailable",
	};
}

function emptyWriterStatus(): TelemetryWriterStatus {
	return { pending: 0, persisted: 0, failed: 0, health_persisted: 0, health_failed: 0 };
}

function nextSequence(records: readonly unknown[], sessionId: string): number {
	let maximum = -1;
	for (const record of records) {
		const sequence = sequenceOf(record, sessionId);
		if (sequence !== undefined) maximum = Math.max(maximum, sequence);
	}
	return maximum + 1;
}

function sequenceOf(record: unknown, sessionId: string | undefined): number | undefined {
	if (!isRecord(record) || record["session_id"] !== sessionId) return undefined;
	const sequence = record["sequence"];
	return typeof sequence === "number" && Number.isInteger(sequence) ? sequence : undefined;
}

function latestCompletedTurn(records: readonly unknown[], sessionId: string): number | undefined {
	let latest: number | undefined;
	for (const record of records) {
		if (!isRecord(record) || record["session_id"] !== sessionId || record["event"] !== "turn_end") continue;
		const data = record["data"];
		if (isRecord(data) && typeof data["turn_index"] === "number") latest = data["turn_index"];
	}
	return latest;
}

function toolCalls(event: TurnEndEvent): Array<{ id: string; name: string }> {
	if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return [];
	return event.message.content.flatMap((part) => part.type === "toolCall" ? [{ id: part.id, name: part.name }] : []);
}

function isDenied(call: ToolCallState): boolean {
	return call.approval?.decision === "deny"
		|| call.approval?.outcome === "deny"
		|| call.approval?.outcome === "deny_with_instruction"
		|| call.approval?.outcome === "dismissed";
}

function safeBranch(ctx: ExtensionContext): ReturnType<ExtensionContext["sessionManager"]["getBranch"]> {
	try {
		return typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
	} catch {
		return [];
	}
}

function safeLeafId(ctx: ExtensionContext): string | null {
	try {
		return typeof ctx.sessionManager.getLeafId === "function" ? ctx.sessionManager.getLeafId() : null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadTelemetrySession(sessionId: string): Promise<TelemetryJsonlSnapshot> {
	const [events, health] = await Promise.all([
		readTelemetryJsonlFile(telemetrySessionFile(sessionId)),
		readTelemetryJsonlFile(telemetryHealthFile(sessionId)),
	]);
	return {
		records: [...events.records, ...health.records],
		invalidLines: events.invalidLines + health.invalidLines,
	};
}

export function registerTelemetry(
	pi: Pick<ExtensionAPI, "events" | "getActiveTools" | "getAllTools" | "getThinkingLevel" | "on">,
	options: TelemetryCollectorOptions = {},
): TelemetryCollector {
	const collector = new TelemetryCollector(options);
	const disposeRuntime = pi.events.on(TELEMETRY_RUNTIME_CHANNEL, (value) => collector.onRuntimeEvent(value));
	pi.on("session_start", (event, ctx) => collector.onSessionStart(event, ctx));
	pi.on("agent_start", (event) => collector.onAgentStart(event));
	pi.on("turn_start", (event, ctx) => collector.onTurnStart(event, ctx, pi));
	pi.on("message_end", (event) => collector.onMessageEnd(event));
	pi.on("tool_execution_start", (event) => collector.onToolExecutionStart(event));
	pi.on("tool_execution_end", (event) => collector.onToolExecutionEnd(event));
	pi.on("turn_end", (event) => collector.onTurnEnd(event));
	pi.on("session_shutdown", async (event) => {
		await collector.onSessionShutdown(event);
		if (event.reason === "reload" || event.reason === "quit") disposeRuntime();
	});
	return collector;
}
