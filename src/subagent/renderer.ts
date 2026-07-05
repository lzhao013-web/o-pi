import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatToolCard } from "../tui/tool-card.js";
import { formatDuration, joinParts } from "../tui/text.js";
import type { SubagentDetails, SubagentRunResult, UsageStats } from "./types.js";

export function renderSubagentCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context?: { isPartial?: boolean }): Text {
	if (context?.isPartial === false) return new Text("", 0, 0);
	const record = isRecord(args) ? args : {};
	return new Text(formatSubagentCall(record, theme), 0, 0);
}

export function renderSubagentResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: Theme): Container | Text {
	const details = isDetails(result.details) ? result.details : undefined;
	if (details === undefined) return new Text(result.content[0]?.text ?? "(no output)", 0, 0);
	const container = new Container();
	if (details.results.length === 0) {
		container.addChild(new Text(result.content[0]?.text ?? "(no output)", 0, 0));
		return container;
	}
	container.addChild(new Text(formatSubagentSummary(details, options.isPartial, theme), 0, 0));
	if (!options.expanded) return container;
	for (const item of details.results) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(formatHeader(item, theme), 0, 0));
		container.addChild(new Text(theme.fg("muted", `task: ${item.task}`), 0, 0));
		container.addChild(new Text(theme.fg("muted", `source: ${item.source} cwd: ${item.cwd}`), 0, 0));
		container.addChild(new Text(theme.fg("muted", `tools: ${item.tools.join(", ")}`), 0, 0));
		if (item.model !== undefined) container.addChild(new Text(theme.fg("muted", `model: ${item.model}`), 0, 0));
		if (item.outputFile !== undefined) container.addChild(new Text(theme.fg("accent", `file: ${item.outputFile}`), 0, 0));
		if (item.stderr !== undefined) container.addChild(new Text(theme.fg("error", truncate(item.stderr, 1600)), 0, 0));
		if (item.output !== undefined) container.addChild(new Text(theme.fg("toolOutput", truncate(item.output, 3000)), 0, 0));
	}
	return container;
}

function formatSubagentCall(record: Record<string, unknown>, theme: Pick<Theme, "fg" | "bold">): string {
	const tasks = Array.isArray(record["tasks"]) ? record["tasks"] : [];
	const mode = record["mode"] === "chain" ? "chain" : "parallel";
	const agents = tasks.map((task) => isRecord(task) && typeof task["agent"] === "string" ? task["agent"] : undefined).filter((agent): agent is string => agent !== undefined);
	return formatToolCard({
		tool: "subagent",
		status: "running",
		target: `${mode} · ${tasks.length} tasks`,
		summary: agents.length > 0 ? agents.join(", ") : "preparing",
	}, theme);
}

function formatSubagentSummary(details: SubagentDetails, isPartial: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const done = details.results.filter((item) => item.exitCode !== -1).length;
	const failed = details.results.find((item) => item.error !== undefined);
	const usage = sumUsage(details.results);
	const status = isPartial ? "running" : failed === undefined ? "success" : "error";
	const summary = failed !== undefined
		? joinParts([`${done}/${details.results.length} complete`, `${failed.agent} failed`, "see expanded output"])
		: joinParts([`${done}/${details.results.length} complete`, usage.turns > 0 ? `${usage.turns} turns` : undefined, formatTokens(totalTokens(usage)), usage.cost !== undefined && usage.cost > 0 ? `$${usage.cost.toFixed(3)}` : undefined]);
	return formatToolCard({ tool: "subagent", status, target: `${details.mode} · ${details.results.length} tasks`, summary }, theme);
}

function formatHeader(result: SubagentRunResult, theme: Theme): string {
	const failed = result.error !== undefined;
	const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const usage = formatUsage(result.usage);
	const parts = [`${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}`, `${result.attempts} attempt${result.attempts === 1 ? "" : "s"}`, formatDuration(result.durationMs)];
	if (usage !== "") parts.push(usage);
	return parts.join(" · ");
}

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns > 0) parts.push(`${usage.turns} turns`);
	const tokens = totalTokens(usage);
	if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
	if (usage.cost !== undefined && usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

function sumUsage(results: SubagentRunResult[]): UsageStats {
	return results.reduce<UsageStats>((sum, item) => ({
		input: sum.input + item.usage.input,
		output: sum.output + item.usage.output,
		cacheRead: sum.cacheRead + item.usage.cacheRead,
		cacheWrite: sum.cacheWrite + item.usage.cacheWrite,
		contextTokens: sum.contextTokens + item.usage.contextTokens,
		turns: sum.turns + item.usage.turns,
		...(sum.cost !== undefined || item.usage.cost !== undefined ? { cost: (sum.cost ?? 0) + (item.usage.cost ?? 0) } : {}),
	}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 });
}

function totalTokens(usage: UsageStats): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	return `${(value / 1000).toFixed(1)}k`;
}

function truncate(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}...`;
}

function isDetails(value: unknown): value is SubagentDetails {
	return isRecord(value) && (value["mode"] === "parallel" || value["mode"] === "chain") && Array.isArray(value["results"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
