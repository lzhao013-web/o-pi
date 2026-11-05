import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const MAX_CALLS = 32;
export const MAX_CONCURRENCY = 4;

const reference = Type.String({ minLength: 1, maxLength: 512 });
const condition = Type.Union([
	Type.Object({ op: Type.Literal("exists"), ref: reference }, { additionalProperties: false }),
	Type.Object({ op: Type.Literal("nonempty"), ref: reference }, { additionalProperties: false }),
	Type.Object({
		op: Type.Literal("eq"), ref: reference,
		value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
	}, { additionalProperties: false }),
], { description: "ref: id.data or id.data.field.0.field. exists tests presence. nonempty tests string/array length > 0. eq compares scalars without conversion. Missing fields fail except with exists. Evaluated once before the call or entire map." });

const call = Type.Object({
	id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$", description: "Unique result ID." }),
	tool: Type.Union([Type.Literal("ls"), Type.Literal("find"), Type.Literal("grep"), Type.Literal("read")]),
	args: Type.Record(Type.String(), Type.Unknown(), {
		description: 'Tool arguments. {"$ref":"id.data.path"} copies a prior result. In map, {"$ref":"$item.path"} copies an item field, "$item" the whole item.',
	}),
	map: Type.Optional(Type.Object({
		from: reference,
		limit: Type.Integer({ minimum: 1, maximum: MAX_CALLS, description: "Process at most this many items from the start." }),
	}, { additionalProperties: false, description: "Repeat this query over a prior result array. Items follow stage mode and share its concurrency limit. No nested maps." })),
	when: Type.Optional(condition),
}, { additionalProperties: false });

export const parameters = Type.Object({
	stages: Type.Array(Type.Object({
		mode: Type.Union([Type.Literal("serial"), Type.Literal("parallel")]),
		calls: Type.Array(call, { minItems: 1, maxItems: MAX_CALLS }),
	}, { additionalProperties: false }), {
		minItems: 1, maxItems: MAX_CALLS,
		description: "Run stages in order. At most 32 calls including map limits. Serial calls may reference earlier calls. Parallel calls may reference only earlier stages.",
	}),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY, description: "Parallel call limit. Default 4." })),
}, { additionalProperties: false });

const error = Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false });
const skippedReason = Type.Union([Type.Literal("condition_false"), Type.Literal("previous_error"), Type.Literal("cancelled")]);
const stepBase = { id: Type.String(), tool: call.properties.tool };
const callStep = Type.Union([
	Type.Object({ ...stepBase, status: Type.Literal("ok"), data: Type.Unsafe<JsonValue>({}) }, { additionalProperties: false }),
	Type.Object({ ...stepBase, status: Type.Literal("error"), error }, { additionalProperties: false }),
	Type.Object({ ...stepBase, status: Type.Literal("skipped"), reason: skippedReason }, { additionalProperties: false }),
]);
const mapInfo = Type.Object({ total: Type.Integer({ minimum: 0 }), truncated: Type.Boolean() }, { additionalProperties: false });
const mapBase = { ...stepBase, map: mapInfo, data: Type.Array(callStep, { maxItems: MAX_CALLS }) };
const mapStep = Type.Union([
	Type.Object({ ...mapBase, status: Type.Literal("ok") }, { additionalProperties: false }),
	Type.Object({ ...mapBase, status: Type.Literal("error"), error }, { additionalProperties: false }),
	Type.Object({ ...mapBase, status: Type.Literal("skipped"), reason: skippedReason }, { additionalProperties: false }),
]);
const step = Type.Union([...callStep.anyOf, ...mapStep.anyOf]);
export const outputSchema = Type.Union([
	Type.Object({
		status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]),
		steps: Type.Array(step),
	}, { additionalProperties: false }),
	Type.Object({ status: Type.Literal("invalid"), steps: Type.Array(step, { maxItems: 0 }), error }, { additionalProperties: false }),
]);

export type Plan = Static<typeof parameters>;
export type Call = Static<typeof call>;
export type Condition = Static<typeof condition>;
export type CallStep = Static<typeof callStep>;
export type MapStep = Static<typeof mapStep>;
export type MapInfo = Static<typeof mapInfo>;
export type Step = Static<typeof step>;
export type Failure = Static<typeof error>;
export type Run = Static<typeof outputSchema>;
