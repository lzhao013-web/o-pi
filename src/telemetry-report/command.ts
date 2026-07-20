import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { TelemetryCollector } from "../telemetry/collector.js";
import { LiveTelemetryReporter } from "./live.js";
import { formatLiveTelemetrySummary } from "./render-tui.js";
import { TelemetryViewer } from "./viewer.js";

export function registerTelemetryCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
	collector: Pick<TelemetryCollector, "snapshot">,
): void {
	const reporter = new LiveTelemetryReporter();
	pi.registerCommand("telemetry", {
		description: "Show current session telemetry analysis.",
		async handler(args, ctx) {
			if (args.trim().length > 0) {
				ctx.ui.notify("usage: /telemetry", "warning");
				return;
			}
			const report = reporter.create(collector);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(formatLiveTelemetrySummary(report), report.report.collection_health.status === "healthy" ? "info" : "warning");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TelemetryViewer(report, theme, () => tui.terminal.rows, done), {
				overlay: true,
			});
		},
	});
}
