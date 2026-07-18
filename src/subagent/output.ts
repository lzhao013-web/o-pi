import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { countTextTokensSync, type TokenCounterScope } from "../token-counter.js";
import { findNearestProjectRoot } from "./config.js";
import type { SubagentRunResult } from "./types.js";

const RUNS_DIR = path.join(".pi", "subagents", "runs");

export interface OutputFormatOptions {
	cwd: string;
	runId: string;
	index: number;
}

export async function persistResult(result: SubagentRunResult, options: OutputFormatOptions): Promise<SubagentRunResult> {
	const runDir = getRunDir(options.cwd, options.runId);
	await mkdir(runDir, { recursive: true });
	const base = `${sanitizeFileName(result.agent)}-${options.index + 1}`;
	const outputFile = path.join(runDir, `${base}.md`);
	const metadataFile = path.join(runDir, `${base}.json`);
	await atomicWrite(outputFile, result.output ?? "");
	await atomicWrite(metadataFile, JSON.stringify(result, null, 2));
	return { ...result, outputFile };
}

export function formatResultForContext(result: SubagentRunResult, maxInlineOutputTokens: number, tokenScope: TokenCounterScope = {}): string {
	const output = result.output ?? "";
	if (!exceedsTokenLimit(output, maxInlineOutputTokens, tokenScope)) return output;
	return result.outputFile === undefined
		? `Subagent ${result.agent} produced too much output for inline return; full output file is unavailable.`
		: `Subagent ${result.agent} produced too much output for inline return; full output saved to ${result.outputFile}.`;
}

export function formatFileHandoff(result: SubagentRunResult): string {
	return result.outputFile === undefined
		? `Previous subagent ${result.agent} output exceeded the handoff limit; full output file is unavailable.`
		: `Previous subagent ${result.agent} output exceeded the handoff limit; full output saved to ${result.outputFile}. Read that file for the complete result.`;
}

export function exceedsTokenLimit(input: string, maxTokens: number, tokenScope: TokenCounterScope = {}): boolean {
	return countTextTokensSync(input, tokenScope).tokens > maxTokens;
}

export function getRunDir(cwd: string, runId: string): string {
	const root = findNearestProjectRoot(cwd) ?? cwd;
	return path.join(root, RUNS_DIR, runId);
}

export function sanitizeFileName(name: string): string {
	const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/^\.+$/, "_");
	return cleaned.length === 0 ? "agent" : cleaned.slice(0, 80);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
	await rename(tempPath, filePath);
}
