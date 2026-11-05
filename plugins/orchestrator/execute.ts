import { EvaluationError, matchesCondition, validatePlan, type ItemScope } from "./plan.ts";
import { selectItems, settleMap } from "./map.ts";
import { query, type QueryContext } from "./query.ts";
import type { DisplayCall, DisplayStep, ExecutionDetails, ExecutionProgress, ExecutionResult, SettledCall, SettledStep } from "./progress.ts";
import { MAX_CONCURRENCY, type Call, type CallStep, type Plan, type Step } from "./schema.ts";

export type { QueryContext } from "./query.ts";

interface Job {
	call: Call;
	item?: ItemScope;
	start(args: Record<string, unknown>): void;
	finish(step: SettledCall): void;
}

function callResult({ invocation: _invocation, ...step }: SettledCall): CallStep {
	return step;
}
function resultStep(step: SettledStep): Step {
	return "map" in step ? { ...step, data: step.data.map(callResult) } : callResult(step);
}

export async function executePlan(
	plan: Plan, ctx: QueryContext, signal?: AbortSignal, onProgress?: (progress: ExecutionProgress) => void,
): Promise<ExecutionResult> {
	const invalid = validatePlan(plan, new Set(ctx.tools.map((tool) => tool.name)));
	if (invalid !== undefined) {
		const details: ExecutionDetails = { status: "invalid", steps: [], error: invalid };
		return { result: details, details };
	}

	const controller = new AbortController();
	const executionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const view: DisplayStep[] = plan.stages.flatMap((stage) => stage.calls.map(({ id, tool }) => ({ id, tool, status: "pending" })));
	const publish = () => onProgress?.({ status: "running", steps: view.slice() });
	const results = new Map<string, Step>();
	const finished: Array<{ slot: number; step: SettledStep; result: Step }> = [];
	let failed = false;
	const skippedReason = (): "cancelled" | "previous_error" | undefined => executionSignal.aborted ? "cancelled" : failed ? "previous_error" : undefined;
	const finish = (slot: number, step: SettledStep) => {
		if (step.status === "error") failed = true;
		const result = resultStep(step);
		results.set(step.id, result);
		view[slot] = step;
		finished.push({ slot, step, result });
		publish();
	};
	const prepare = (call: Call, slot: number): Job[] => {
		const base = { id: call.id, tool: call.tool };
		const reason = skippedReason();
		if (reason !== undefined) {
			finish(slot, { ...base, status: "skipped", reason });
			return [];
		}
		if (call.map === undefined) return [{
			call,
			start(args) { view[slot] = { ...base, status: "running", args }; publish(); },
			finish(step) { finish(slot, step); },
		}];

		let selection: ReturnType<typeof selectItems>;
		try {
			if (call.when !== undefined && !matchesCondition(call.when, results)) {
				finish(slot, { ...base, status: "skipped", reason: "condition_false" });
				return [];
			}
			selection = selectItems(call.map, results);
		} catch (error) {
			if (!(error instanceof EvaluationError)) throw error;
			finish(slot, { ...base, status: "error", error: { code: error.code, message: error.message } });
			return [];
		}
		const { info, items } = selection;
		if (items.length === 0) {
			finish(slot, settleMap(call, info, []));
			return [];
		}
		const children: DisplayCall[] = items.map((_, index) => ({ id: `${call.id}/${index}`, tool: call.tool, status: "pending" }));
		const completed: Array<{ index: number; step: SettledCall }> = [];
		const update = (status: "pending" | "running") => {
			view[slot] = { ...base, status, map: info, data: children.slice() };
			publish();
		};
		update("pending");
		return items.map((value, index) => {
			const child = { id: `${call.id}/${index}`, tool: call.tool, args: call.args };
			return {
				call: child, item: { value },
				start(args) { children[index] = { ...child, status: "running", args }; update("running"); },
				finish(step) {
					children[index] = step;
					completed.push({ index, step });
					if (completed.length === items.length) {
						finish(slot, settleMap(call, info, completed.sort((a, b) => a.index - b.index).map((item) => item.step)));
					} else update("running");
				},
			};
		});
	};
	const dispatch = async (jobs: Job[], concurrency: number) => {
		const iterator = jobs.values();
		const worker = async () => {
			try {
				for (const job of iterator) {
					const reason = skippedReason();
					const step: SettledCall = reason === undefined
						? await query(job.call, results, ctx, executionSignal, job.start, job.item)
						: { id: job.call.id, tool: job.call.tool, status: "skipped", reason };
					if (step.status === "error") failed = true;
					job.finish(step);
				}
			} catch (error) {
				// 观察者或宿主异常时取消同阶段调用，等待资源释放后传播原错误。
				controller.abort();
				throw error;
			}
		};
		const completed = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
		for (const result of completed) if (result.status === "rejected") throw result.reason;
	};

	let offset = 0;
	publish();
	for (const stage of plan.stages) {
		if (stage.mode === "parallel") {
			await dispatch(stage.calls.flatMap((call, index) => prepare(call, offset + index)), plan.concurrency ?? MAX_CONCURRENCY);
		} else {
			for (const [index, call] of stage.calls.entries()) await dispatch(prepare(call, offset + index), 1);
		}
		offset += stage.calls.length;
	}
	const status = signal?.aborted ? "cancelled" : failed ? "failed" : "completed";
	finished.sort((a, b) => a.slot - b.slot);
	return { result: { status, steps: finished.map((item) => item.result) }, details: { status, steps: finished.map((item) => item.step) } };
}
