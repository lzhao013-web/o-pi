import type { TuiIconMode } from "./types.js";

export type ToolCardStatus = "running" | "success" | "error" | "warning" | "neutral";

const unicodeIcons: Record<ToolCardStatus, string> = {
	running: "●",
	success: "✓",
	error: "✕",
	warning: "!",
	neutral: "·",
};

const asciiIcons: Record<ToolCardStatus, string> = {
	running: "..",
	success: "OK",
	error: "ER",
	warning: "!!",
	neutral: "--",
};

/** 返回普通 Unicode 或 ASCII 状态图标；nerd/auto 在 V1 中不强依赖特殊字体。 */
export function statusIcon(status: ToolCardStatus, mode: TuiIconMode): string {
	if (mode === "ascii") return asciiIcons[status];
	return unicodeIcons[status];
}
