import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApprovalGate } from "../../src/approval/gate.js";
import { emitTelemetryRuntime } from "../../src/telemetry/channel.js";

export default function approvalGateExtension(pi: ExtensionAPI): void {
	const gate = createApprovalGate({
		telemetry(toolCallId, toolName, approval) {
			emitTelemetryRuntime(pi.events, {
				kind: "approval",
				tool_call_id: toolCallId,
				tool_name: toolName,
				approval,
			});
		},
	});
	pi.on("tool_call", async (event, ctx) => gate.handleToolCall(event, ctx));
}
