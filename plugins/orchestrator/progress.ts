import type { Call, CallStep, Failure, MapInfo, MapStep, Run } from "./schema.ts";

export interface Invocation {
	args: Record<string, unknown>;
	durationMs: number;
}

export type SettledCall = CallStep & { invocation?: Invocation };
export type DisplayCall = SettledCall
	| Pick<Call, "id" | "tool"> & { status: "pending" }
	| Pick<Call, "id" | "tool"> & { status: "running"; args: Record<string, unknown> };
export type SettledMap = MapStep & { data: SettledCall[] };
export type DisplayMap = SettledMap | Pick<Call, "id" | "tool"> & {
	status: "pending" | "running"; map: MapInfo; data: DisplayCall[];
};
export type SettledStep = SettledCall | SettledMap;
export type DisplayStep = DisplayCall | DisplayMap;

export interface ExecutionProgress {
	status: "running";
	steps: DisplayStep[];
}

export type ExecutionDetails = { status: "completed" | "failed" | "cancelled"; steps: SettledStep[] }
	| { status: "invalid"; steps: []; error: Failure };
export type ExecutionView = ExecutionProgress | ExecutionDetails;
export interface ExecutionResult { result: Run; details: ExecutionDetails }
