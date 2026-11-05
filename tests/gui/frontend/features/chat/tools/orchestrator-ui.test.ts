import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { ExecutionView } from "../../../../../../plugins/orchestrator/progress.ts";
import type { Plan } from "../../../../../../plugins/orchestrator/schema.ts";
import { ToolActivity } from "../../../../../../src/gui/frontend/features/chat/tools/tool-activity.tsx";
import type { ToolActivity as Activity } from "../../../../../../src/gui/frontend/features/chat/tools/activity.ts";
import { DisclosureMemory } from "../../../../../../src/gui/frontend/ui/disclosure-memory.ts";
import { renderWithMemory } from "../../../../helpers/render.ts";

const plan: Plan = { concurrency: 2, stages: [
	{ mode: "serial", calls: [{ id: "files", tool: "find", args: { query: "a.txt" } }] },
	{ mode: "parallel", calls: [
		{ id: "body", tool: "read", args: { path: { $ref: "files.data.matches.0.path" } }, when: { op: "nonempty", ref: "files.data.matches" } },
		{ id: "listing", tool: "ls", args: {}, when: { op: "exists", ref: "files.data.missing" } },
	] },
	{ mode: "serial", calls: [{ id: "last", tool: "read", args: { path: "missing.txt" } }] },
] };
const tool: Activity = { id: "flow", name: "orchestrate", args: plan, state: "running", output: undefined };
const invocation = { args: { path: "a.txt" }, durationMs: 13 };
function withDetails(details: ExecutionView, state: Activity["state"] = "running"): Activity {
	return { ...tool, state, output: { kind: "inline", value: { content: [{ type: "text", text: "model output" }], details } } };
}
function render(value: Activity, entries: Array<[string, boolean]> = [["tool:flow", true]]) {
	return parseHTML(renderWithMemory(createElement(ToolActivity, { tool: value }), new DisclosureMemory(entries))).document;
}
const progress: ExecutionView = { status: "running", steps: [
	{ id: "files", tool: "find", status: "ok", data: { matches: [{ path: "a.txt" }] }, invocation },
	{ id: "body", tool: "read", status: "running", args: { path: "a.txt" } },
	{ id: "listing", tool: "ls", status: "skipped", reason: "condition_false" },
	{ id: "last", tool: "read", status: "pending" },
] };

describe("编排器执行流程", () => {
	it("按阶段表达串行和并发，展示真实步骤状态、已解析目标和条件", () => {
		const doc = render(withDetails(progress));
		expect(doc.querySelectorAll(".orchestrator-stage")).toHaveLength(3);
		expect(doc.querySelectorAll('[data-mode="parallel"] .orchestrator-operation')).toHaveLength(2);
		expect(doc.querySelector(".orchestrator-limit")?.textContent).toBe("上限 2");
		expect(doc.querySelector('[data-operation-id="files"]')?.getAttribute("data-state")).toBe("completed");
		expect(doc.querySelector('[data-operation-id="body"]')?.getAttribute("data-state")).toBe("running");
		expect(doc.querySelector('[data-operation-id="body"] .orchestrator-target')?.textContent).toBe("a.txt");
		expect(doc.querySelector('[data-operation-id="body"] .orchestrator-condition')?.textContent).toContain("files.data.matches 非空");
		expect(doc.querySelector('[data-operation-id="listing"] .orchestrator-reason')?.textContent).toBe("条件不满足");
		expect(doc.querySelector('[data-operation-id="last"]')?.getAttribute("data-state")).toBe("pending");
		expect(doc.querySelector('[role="status"]')?.textContent).toContain("2/4");
	});

	it("历史结果无实时事件也能恢复图形、耗时和实际结果", () => {
		const value = withDetails({ status: "cancelled", steps: [
			{ id: "files", tool: "find", status: "ok", data: { matches: [{ path: "a.txt" }] } },
			{ id: "body", tool: "read", status: "ok", data: "source content", invocation },
			{ id: "listing", tool: "ls", status: "skipped", reason: "condition_false" },
			{ id: "last", tool: "read", status: "skipped", reason: "cancelled" },
		] }, "failed");
		const doc = render(value, [["tool:flow", true], ["orchestrate:flow:1:0", true]]);
		expect(doc.querySelector('[data-operation-id="body"] .orchestrator-duration')?.textContent).toBe("13 ms");
		expect(doc.querySelector('[data-operation-id="body"] .orchestrator-operation-details')?.textContent).toContain("source content");
		expect(doc.querySelector('[data-operation-id="body"] .tool-parameters')?.textContent).toContain("调用参数");
		expect(doc.querySelector('[data-operation-id="last"] .orchestrator-reason')?.textContent).toContain("已取消");
	});

	it("失败节点自动展开错误，前序失败跳过不伪装成执行失败", () => {
		const doc = render(withDetails({ status: "failed", steps: [
			{ id: "files", tool: "find", status: "error", error: { code: "tool_error", message: "Permission denied" } },
			{ id: "body", tool: "read", status: "skipped", reason: "previous_error" },
		] }, "failed"));
		expect(doc.querySelector('[data-operation-id="files"] [role="alert"]')?.textContent).toContain("Permission denied");
		expect(doc.querySelector('[data-operation-id="body"]')?.getAttribute("data-state")).toBe("skipped");
		expect(doc.querySelector('[data-operation-id="body"] .orchestrator-reason')?.textContent).toContain("前序操作失败");
		expect(doc.querySelectorAll('[data-state="failed"].orchestrator-operation')).toHaveLength(1);
	});

	it("手动折叠优先于失败自动展开", () => {
		const value = withDetails({ status: "failed", steps: [
			{ id: "files", tool: "find", status: "error", error: { code: "tool_error", message: "denied" } },
		] }, "failed");
		const doc = render(value, [["tool:flow", false]]);
		expect(doc.querySelector('[data-tool="orchestrate"] .activity-summary')?.getAttribute("aria-expanded")).toBe("false");
		expect(doc.querySelector(".orchestrator-flow")).toBeNull();
	});

	it("取消使用停止语义，缺失步骤状态不猜测为成功或跳过", () => {
		const cancelled = render(withDetails({ status: "cancelled", steps: plan.stages.flatMap((stage) => stage.calls.map((call) => ({
			id: call.id, tool: call.tool, status: "skipped", reason: "cancelled",
		}))) }, "failed"));
		expect(cancelled.querySelector('[data-tool="orchestrate"]')?.getAttribute("data-state")).toBe("stopped");
		const interrupted = render({ ...tool, state: "stopped" });
		expect(interrupted.querySelectorAll('.orchestrator-operation[data-state="unavailable"]')).toHaveLength(4);
		expect(interrupted.querySelectorAll('.orchestrator-operation[data-state="skipped"]')).toHaveLength(0);
	});

	it("无效计划明确未执行，保留执行前错误", () => {
		const doc = render(withDetails({ status: "invalid", steps: [], error: { code: "unavailable_tool", message: "read is not callable" } }, "failed"));
		expect(doc.querySelector('[role="alert"]')?.textContent).toContain("read is not callable");
		expect(doc.querySelector('[data-operation-id="files"] .orchestrator-operation-state')?.textContent).toContain("未执行");
	});

	it("大结果按引用读取前展示计划，不把缺失预览当成完成", () => {
		const doc = render({ ...tool, state: "completed", output: { kind: "reference", id: "large/1", facts: "", preview: { content: [], details: { status: "completed" } } } });
		expect(doc.querySelectorAll(".orchestrator-operation")).toHaveLength(4);
		expect(doc.querySelector('[data-tool="orchestrate"]')?.textContent).toContain("正在读取步骤状态");
		expect(doc.querySelector('[data-tool="orchestrate"]')?.textContent).not.toContain("步骤终态未保留");
		expect(doc.querySelectorAll('.orchestrator-operation[data-state="completed"]')).toHaveLength(0);
	});

	it("映射实时展示选取数量、每项状态和已解析目标，历史按相同顺序恢复", () => {
		const mappedPlan: Plan = { stages: [{ mode: "parallel", calls: [{ id: "bodies", tool: "read", args: { path: { $ref: "$item.path" } }, map: { from: "files.data.matches", limit: 2 } }] }] };
		const value = withDetails({ status: "running", steps: [{ id: "bodies", tool: "read", status: "running", map: { total: 3, truncated: true }, data: [
			{ id: "bodies/0", tool: "read", status: "ok", data: "source content", invocation },
			{ id: "bodies/1", tool: "read", status: "running", args: { path: "b.txt" } },
		] }] });
		const doc = render({ ...value, args: mappedPlan }, [["tool:flow", true], ["orchestrate:flow:0:0:item:0", true]]);
		expect(doc.querySelector(".orchestrator-map")?.textContent).toContain("1/2");
		expect(doc.querySelector(".orchestrator-map")?.textContent).toContain("源数组共 3 项，仅处理前 2 项");
		expect(doc.querySelector('[data-operation-id="bodies/0"]')?.getAttribute("data-state")).toBe("completed");
		expect(doc.querySelector('[data-operation-id="bodies/0"] .orchestrator-operation-details')?.textContent).toContain("source content");
		expect(doc.querySelector('[data-operation-id="bodies/1"] .orchestrator-target')?.textContent).toBe("b.txt");
		expect(doc.querySelectorAll(".orchestrator-map-items > li")).toHaveLength(2);
	});

	it("空映射显示成功与零项，不虚构查询或跳过节点", () => {
		const value = withDetails({ status: "completed", steps: [{ id: "bodies", tool: "read", status: "ok", map: { total: 0, truncated: false }, data: [] }] }, "completed");
		const doc = render({ ...value, args: { stages: [{ mode: "parallel", calls: [{ id: "bodies", tool: "read", args: {}, map: { from: "files.data.matches", limit: 2 } }] }] } });
		expect(doc.querySelector(".orchestrator-map")?.textContent).toContain("源数组为空，无需调用");
		expect(doc.querySelector(".orchestrator-map")?.getAttribute("data-state")).toBe("completed");
		expect(doc.querySelectorAll(".orchestrator-map-items > li")).toHaveLength(0);
	});

	it("映射聚合失败保留逐项错误与跳过原因", () => {
		const value = withDetails({ status: "failed", steps: [{ id: "bodies", tool: "read", status: "error", error: { code: "map_failed", message: "1 map item(s) failed." }, map: { total: 2, truncated: false }, data: [
			{ id: "bodies/0", tool: "read", status: "error", error: { code: "tool_error", message: "Permission denied" } },
			{ id: "bodies/1", tool: "read", status: "skipped", reason: "previous_error" },
		] }] }, "failed");
		const doc = render({ ...value, args: { stages: [{ mode: "parallel", calls: [{ id: "bodies", tool: "read", args: {}, map: { from: "files.data.matches", limit: 2 } }] }] } });
		expect(doc.querySelector('[data-operation-id="bodies/0"] [role="alert"]')?.textContent).toContain("Permission denied");
		expect(doc.querySelector('[data-operation-id="bodies/1"] .orchestrator-reason')?.textContent).toContain("前序操作失败");
	});

	it("参数尚未完整到达时展示生成状态，不渲染错误流程", () => {
		const doc = render({ ...tool, state: "preparing", args: { stages: [{ mode: "parallel" }] } });
		expect(doc.querySelector('[data-tool="orchestrate"]')?.textContent).toContain("正在生成编排计划");
		expect(doc.querySelector(".orchestrator-flow")).toBeNull();
	});
});
