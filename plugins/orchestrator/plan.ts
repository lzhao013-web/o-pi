import { MAX_CALLS, type Call, type Condition, type Failure, type Plan, type Step } from "./schema.ts";

export class EvaluationError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapValue(value: unknown, resolve: (reference: string) => unknown): unknown {
	if (Array.isArray(value)) return value.map((item: unknown) => mapValue(item, resolve));
	if (!isObject(value)) return value;
	if (Object.hasOwn(value, "$ref")) {
		if (typeof value.$ref !== "string" || Object.keys(value).length !== 1) {
			throw new EvaluationError("invalid_reference", "A reference must contain only a string $ref.");
		}
		return resolve(value.$ref);
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapValue(item, resolve)]));
}

/** 并发阶段只向下一阶段公开结果，避免执行时序影响引用是否合法。 */
export function validatePlan(plan: Plan, available: ReadonlySet<string>): Failure | undefined {
	const seen = new Set<string>();
	const visible = new Set<string>();
	let count = 0;
	try {
		for (const stage of plan.stages) {
			for (const call of stage.calls) {
				count += call.map?.limit ?? 1;
				if (count > MAX_CALLS) throw new EvaluationError("call_limit", `At most ${MAX_CALLS} calls are allowed, counting each map limit.`);
				if (seen.has(call.id)) throw new EvaluationError("duplicate_id", `Duplicate step ID: ${call.id}.`);
				seen.add(call.id);
				if (!available.has(call.tool)) throw new EvaluationError("unavailable_tool", `${call.id}: tool ${call.tool} is not callable.`);
				const checkReference = (reference: string, allowItem = false) => {
					const [id, field, ...path] = reference.split(".");
					if (id === "$item" && allowItem && reference.split(".").every((part) => part.length > 0)) return;
					if (id === undefined || field !== "data" || path.some((part) => part.length === 0) || !visible.has(id)) {
						throw new EvaluationError("invalid_reference", `${call.id}: unavailable result reference ${reference}.`);
					}
				};
				mapValue(call.args, (reference) => checkReference(reference, call.map !== undefined));
				if (call.map !== undefined) checkReference(call.map.from);
				if (call.when !== undefined) checkReference(call.when.ref);
				if (stage.mode === "serial") visible.add(call.id);
			}
			for (const call of stage.calls) visible.add(call.id);
		}
	} catch (error) {
		if (!(error instanceof EvaluationError)) throw error;
		return { code: error.code, message: error.message };
	}
	return undefined;
}

function lookup(reference: string, results: ReadonlyMap<string, Step>, item?: ItemScope): { found: true; value: unknown } | { found: false } {
	const [id, ...path] = reference.split(".");
	let value: unknown = id === "$item" ? item?.value : id === undefined ? undefined : results.get(id);
	for (const part of path) {
		if ((!isObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, part)) return { found: false };
		value = Reflect.get(value, part);
	}
	return { found: true, value };
}

export function requiredValue(reference: string, results: ReadonlyMap<string, Step>, item?: ItemScope): unknown {
	const result = lookup(reference, results, item);
	if (!result.found) throw new EvaluationError("missing_reference", `Result field is unavailable: ${reference}.`);
	return result.value;
}

export interface ItemScope { value: unknown }

export function resolveArguments(call: Call, results: ReadonlyMap<string, Step>, item?: ItemScope): Record<string, unknown> {
	const args = mapValue(call.args, (reference) => structuredClone(requiredValue(reference, results, item)));
	if (!isObject(args)) throw new EvaluationError("invalid_arguments", `${call.id}: arguments must resolve to an object.`);
	return args;
}

export function matchesCondition(condition: Condition, results: ReadonlyMap<string, Step>): boolean {
	if (condition.op === "exists") return lookup(condition.ref, results).found;
	const value = requiredValue(condition.ref, results);
	if (condition.op === "nonempty") {
		if (typeof value !== "string" && !Array.isArray(value)) {
			throw new EvaluationError("condition_type", `nonempty requires a string or array: ${condition.ref}.`);
		}
		return value.length > 0;
	}
	if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
		throw new EvaluationError("condition_type", `eq requires a scalar: ${condition.ref}.`);
	}
	return value === condition.value;
}
