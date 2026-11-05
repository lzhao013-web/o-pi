import { ChevronRight, GitFork, Repeat2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { useDisclosureMemory } from "@/ui/disclosure-memory.ts";
import { pretty } from "@/ui/content/format.ts";
import type { Call } from "../../../../../../plugins/orchestrator/schema.ts";
import type { DisplayCall, DisplayStep } from "../../../../../../plugins/orchestrator/progress.ts";
import type { ToolState } from "../../../../shared/messages/types.ts";
import { ActivityIcon, toolDisplay, toolStates } from "./tool-display.tsx";
import { ParameterValue } from "./tool-parameters.tsx";
import { RawToolContent } from "./tool-results.tsx";
import { toolTarget } from "./tool-target.ts";
import { conditionText, skipReasons, stepState } from "./orchestrator-view.ts";

interface OperationProps {
	call: Call; step: DisplayStep | undefined; parent: ToolState; invalid: boolean; memoryKey: string;
}
export function Operation(props: OperationProps) {
	if (props.call.map !== undefined) return <MapOperation {...props} mapping={props.call.map} />;
	return <QueryOperation {...props} step={props.step && !("map" in props.step) ? props.step : undefined} />;
}

function OperationState({ state, invalid }: { state: ToolState | "skipped"; invalid: boolean }) {
	const label = invalid ? "未执行" : state === "skipped" ? "已跳过" : state === "unavailable" ? "终态未知" : toolStates[state];
	return <><span aria-hidden="true"><ActivityIcon state={state} /></span><span>{label}</span></>;
}
function Condition({ call }: { call: Call }) {
	return call.when && <p className="orchestrator-condition"><GitFork aria-hidden="true" /><span>条件 <code>{conditionText(call.when)}</code></span></p>;
}

function MapOperation({ call, step, parent, invalid, memoryKey, mapping }: OperationProps & { mapping: NonNullable<Call["map"]> }) {
	const [expanded, setExpanded] = useDisclosureMemory(`orchestrate:${memoryKey}`, null);
	const open = expanded ?? true;
	const state = stepState(step, parent);
	const mapped = step && "map" in step ? step : undefined;
	const done = mapped?.data.filter((item) => item.status !== "pending" && item.status !== "running").length ?? 0;
	return <li className="orchestrator-map" data-operation-id={call.id} data-state={state}>
		<Collapsible open={open} onOpenChange={setExpanded}>
			<CollapsibleTrigger className="orchestrator-operation-trigger">
				<Repeat2 aria-hidden="true" /><span className="orchestrator-operation-title"><span><strong>{call.tool}</strong><code>{call.id}</code><span>映射</span></span>
					<code className="orchestrator-target">{mapping.from}</code></span>
				<span className="orchestrator-operation-state" data-state={state}>
					<OperationState state={state} invalid={invalid} /><span>{mapped ? `${done}/${mapped.data.length}` : `最多 ${mapping.limit} 项`}</span>
				</span><ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
			</CollapsibleTrigger>
			<Condition call={call} />
			{step?.status === "skipped" && <p className="orchestrator-reason">{skipReasons[step.reason]}</p>}
			<CollapsibleContent lazy><div className="orchestrator-map-body">
				{mapped?.map.truncated && <p className="tool-note">源数组共 {mapped.map.total} 项，仅处理前 {mapped.data.length} 项。</p>}
				{mapped?.map.total === 0 && <p className="tool-note">源数组为空，无需调用。</p>}
				{step?.status === "error" && <p className="orchestrator-error" role="alert"><code>{step.error.code}</code>{step.error.message}</p>}
				{mapped && mapped.data.length > 0 && <ol className="orchestrator-map-items" aria-label={`${call.id} 映射项`}>
					{mapped.data.map((item, index) => <QueryOperation key={item.id} call={{ id: item.id, tool: call.tool, args: call.args }}
						step={item} parent={parent} invalid={invalid} memoryKey={`${memoryKey}:item:${index}`} />)}
				</ol>}
				<Disclosure className="tool-parameters" summary="映射模板" lazy><ParameterValue value={call.args} /></Disclosure>
			</div></CollapsibleContent>
		</Collapsible>
	</li>;
}

function QueryOperation({ call, step, parent, invalid, memoryKey }: Omit<OperationProps, "step"> & { step: DisplayCall | undefined }) {
	const [expanded, setExpanded] = useDisclosureMemory(`orchestrate:${memoryKey}`, null);
	const state = stepState(step, parent);
	const open = expanded ?? state === "failed";
	const invocation = step && step.status !== "running" && step.status !== "pending" ? step.invocation : undefined;
	const args = invocation?.args ?? (step?.status === "running" ? step.args : call.args);
	const target = toolTarget(call.tool, args);
	const { icon: Icon } = toolDisplay(call.tool);
	return <li className="orchestrator-operation" data-operation-id={call.id} data-state={state}>
		<Collapsible open={open} onOpenChange={setExpanded}>
			<CollapsibleTrigger className="orchestrator-operation-trigger">
				<Icon className="orchestrator-tool-icon" aria-hidden="true" />
				<span className="orchestrator-operation-title"><span><strong>{call.tool}</strong><code>{call.id}</code></span>
					{target && <code className="orchestrator-target">{target}</code>}</span>
				<span className="orchestrator-operation-state" data-state={state}>
					<OperationState state={state} invalid={invalid} />
					{invocation && <span className="orchestrator-duration">{invocation.durationMs} ms</span>}
				</span>
				<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
			</CollapsibleTrigger>
			<Condition call={call} />
			{step?.status === "skipped" && <p className="orchestrator-reason">{skipReasons[step.reason]}</p>}
			<CollapsibleContent lazy><div className="orchestrator-operation-details">
				<Disclosure className="tool-parameters" summary={invocation ? "调用参数" : step?.status === "running" ? "已解析参数" : "计划参数"} lazy>
					<ParameterValue value={args} />
				</Disclosure>
				{step?.status === "error" && <p className="orchestrator-error" role="alert"><code>{step.error.code}</code>{step.error.message}</p>}
				{step?.status === "ok" && <RawToolContent value={typeof step.data === "string" ? step.data : pretty(step.data)} />}
			</div></CollapsibleContent>
		</Collapsible>
	</li>;
}
