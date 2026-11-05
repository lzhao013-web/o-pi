import { ArrowDown, ChevronRight, GitFork, Workflow } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { useDisclosureMemory } from "@/ui/disclosure-memory.ts";
import { record } from "@/ui/content/format.ts";
import type { Plan } from "../../../../../../plugins/orchestrator/schema.ts";
import { outputPreview } from "../../../../shared/messages/output.ts";
import type { ToolActivity } from "./activity.ts";
import { ActivityError, ActivityState, errorSummary, toolStates } from "./tool-display.tsx";
import { ToolBody } from "./tool-body.tsx";
import { ParameterValue } from "./tool-parameters.tsx";
import { RawToolContent } from "./tool-results.tsx";
import { useToolOutput } from "./use-tool-output.ts";
import { isOrchestratorPlan, isOrchestratorView, runLabels } from "./orchestrator-view.ts";
import { Operation } from "./orchestrator-operation.tsx";
import "./orchestrator.css";

export function OrchestratorActivity({ tool }: { tool: ToolActivity }) {
	const [expanded, setExpanded] = useDisclosureMemory(`tool:${tool.id}`, null);
	const active = tool.state === "running" || tool.state === "preparing" || tool.state === "pending";
	const open = expanded ?? (active || tool.state === "failed");
	const plan = isOrchestratorPlan(tool.args) ? tool.args : undefined;
	const preview = outputPreview(tool.output)?.details;
	const status = record(preview) && typeof preview.status === "string" ? preview.status : "";
	const state = status === "cancelled" ? "stopped" : tool.state;
	const label = Object.hasOwn(runLabels, status) ? runLabels[status as keyof typeof runLabels] : toolStates[state];
	return <section className="tool-activity orchestrator-activity" data-tool="orchestrate" data-state={state} data-tool-call-id={tool.id}>
		<Collapsible open={open} onOpenChange={setExpanded}>
			<CollapsibleTrigger className="activity-summary">
				<Workflow className="activity-icon" aria-hidden="true" /><span className="activity-label">查询编排</span>
				<span className="activity-tail">
					<ActivityState state={state} label={label} durationMs={tool.durationMs}
						facts={plan ? `${plan.stages.length} 个阶段 / ${plan.stages.reduce((count, stage) => count + stage.calls.length, 0)} 个步骤` : undefined} />
					<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent lazy>
				{plan ? <OrchestratorFlow tool={tool} plan={plan} /> : active
					? <p className="tool-note">正在生成编排计划…</p> : <ToolBody tool={tool} />}
			</CollapsibleContent>
		</Collapsible>
	</section>;
}

function OrchestratorFlow({ tool, plan }: { tool: ToolActivity; plan: Plan }) {
	const id = tool.output?.kind === "reference" ? tool.output.id : undefined;
	const loaded = useToolOutput(id);
	const output = loaded.value ?? outputPreview(tool.output);
	const details = isOrchestratorView(output?.details) ? output.details : undefined;
	const steps = new Map(details?.steps.map((step) => [step.id, step]));
	const settled = details?.steps.filter((step) => step.status !== "pending" && step.status !== "running").length ?? 0;
	const total = plan.stages.reduce((count, stage) => count + stage.calls.length, 0);
	const parentActive = tool.state === "preparing" || tool.state === "pending" || tool.state === "running";
	const resolved = !id || loaded.value !== undefined || loaded.error !== "";
	const error = details?.status === "invalid" ? details.error.message : resolved && !details && tool.state === "failed" ? errorSummary(tool) : "";
	return <div className="orchestrator-body">
		<ActivityError>{error}</ActivityError>
		<p className="sr-only" role="status" aria-live="polite">{settled}/{total} 个步骤已结束</p>
		{loaded.error && <p className="tool-note error" role="alert">{loaded.error}</p>}
		{id && !loaded.value && !loaded.error && <p className="tool-note" role="status">正在读取步骤状态…</p>}
		<ol className="orchestrator-flow" aria-label="编排执行流程">
			{plan.stages.map((stage, index) => <li className="orchestrator-stage" data-mode={stage.mode} key={index}>
				<div className="orchestrator-stage-heading">
					{stage.mode === "parallel" ? <GitFork aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
					<span>阶段 {index + 1}</span><strong>{stage.mode === "parallel" ? "并发" : "串行"}</strong>
					{stage.mode === "parallel" && <span className="orchestrator-limit">上限 {plan.concurrency ?? 4}</span>}
				</div>
				<ol className="orchestrator-stage-calls" aria-label={`阶段 ${index + 1} ${stage.mode === "parallel" ? "并发" : "串行"}`}>
					{stage.calls.map((call, callIndex) => <Operation key={`${callIndex}:${call.id}`} call={call} step={steps.get(call.id)}
						parent={tool.state} invalid={details?.status === "invalid"} memoryKey={`${tool.id}:${index}:${callIndex}`} />)}
				</ol>
			</li>)}
		</ol>
		{resolved && !parentActive && !details && <p className="tool-note">步骤终态未保留，不能确认各操作是否完成。</p>}
		<Disclosure className="tool-parameters" summary="编排参数" lazy><ParameterValue value={plan} /></Disclosure>
		{output !== undefined && <Disclosure className="tool-raw" summary="输出给模型" lazy><RawToolContent value={output.content} /></Disclosure>}
	</div>;
}
