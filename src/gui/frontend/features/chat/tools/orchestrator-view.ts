import type { Call, Condition, Plan } from "../../../../../../plugins/orchestrator/schema.ts";
import type { DisplayCall, DisplayStep, ExecutionView, Invocation, SettledCall, SettledStep } from "../../../../../../plugins/orchestrator/progress.ts";
import type { ToolState } from "../../../../shared/messages/types.ts";
import { record } from "@/ui/content/format.ts";

function condition(value: unknown): value is Condition {
	if (!record(value) || typeof value.ref !== "string") return false;
	return value.op === "exists" || value.op === "nonempty" || (value.op === "eq"
		&& (value.value === null || typeof value.value === "string" || typeof value.value === "number" || typeof value.value === "boolean"));
}
function call(value: unknown): value is Call {
	return record(value) && callIdentity(value) && record(value.args)
		&& (value.map === undefined || (record(value.map) && typeof value.map.from === "string" && typeof value.map.limit === "number"))
		&& (value.when === undefined || condition(value.when));
}
export function isOrchestratorPlan(value: unknown): value is Plan {
	return record(value) && Array.isArray(value.stages) && value.stages.length > 0
		&& value.stages.every((stage: unknown) => record(stage) && (stage.mode === "serial" || stage.mode === "parallel")
			&& Array.isArray(stage.calls) && stage.calls.every(call))
		&& (value.concurrency === undefined || typeof value.concurrency === "number");
}
function invocation(value: unknown): value is Invocation {
	return record(value) && record(value.args) && typeof value.durationMs === "number";
}
function failure(value: unknown): boolean {
	return record(value) && typeof value.code === "string" && typeof value.message === "string";
}
function terminal(value: Record<string, unknown>): boolean {
	return (value.status === "ok" && Object.hasOwn(value, "data")) || (value.status === "error" && failure(value.error))
		|| (value.status === "skipped" && (value.reason === "condition_false" || value.reason === "previous_error" || value.reason === "cancelled"));
}
function settledCall(value: unknown): value is SettledCall {
	return record(value) && callIdentity(value) && value.map === undefined && terminal(value)
		&& (value.invocation === undefined || invocation(value.invocation));
}
function callIdentity(value: Record<string, unknown>): boolean {
	return typeof value.id === "string" && (value.tool === "ls" || value.tool === "find" || value.tool === "grep" || value.tool === "read");
}
function displayCall(value: unknown): value is DisplayCall {
	return settledCall(value) || (record(value) && callIdentity(value) && value.map === undefined
		&& (value.status === "pending" || (value.status === "running" && record(value.args))));
}
function mapIdentity(value: Record<string, unknown>): boolean {
	return callIdentity(value) && record(value.map) && typeof value.map.total === "number" && typeof value.map.truncated === "boolean";
}
function settled(value: unknown): value is SettledStep {
	return settledCall(value) || (record(value) && mapIdentity(value) && terminal(value) && Array.isArray(value.data) && value.data.every(settledCall));
}
function displayStep(value: unknown): value is DisplayStep {
	return settled(value) || displayCall(value) || (record(value) && mapIdentity(value)
		&& (value.status === "pending" || value.status === "running") && Array.isArray(value.data) && value.data.every(displayCall));
}
export function isOrchestratorView(value: unknown): value is ExecutionView {
	if (!record(value) || !Array.isArray(value.steps)) return false;
	if (value.status === "running") return value.steps.every(displayStep);
	if (value.status === "invalid") return value.steps.length === 0 && failure(value.error);
	return (value.status === "completed" || value.status === "failed" || value.status === "cancelled") && value.steps.every(settled);
}

export function stepState(step: DisplayStep | undefined, parent: ToolState): ToolState | "skipped" {
	if (step?.status === "ok") return "completed";
	if (step?.status === "error") return "failed";
	if (step?.status === "skipped") return "skipped";
	const active = parent === "running" || parent === "pending" || parent === "preparing";
	if (!active) return step?.status === "running" && parent === "stopped" ? "stopped" : "unavailable";
	return step?.status === "running" ? "running" : "pending";
}

export function conditionText(value: Condition): string {
	if (value.op === "exists") return `${value.ref} 存在`;
	if (value.op === "nonempty") return `${value.ref} 非空`;
	return `${value.ref} = ${JSON.stringify(value.value)}`;
}

export const skipReasons = { condition_false: "条件不满足", previous_error: "前序操作失败，未执行", cancelled: "已取消，未执行" };
export const runLabels = { completed: "编排完成", failed: "编排失败", cancelled: "已取消", invalid: "计划无效", running: "执行中" };
