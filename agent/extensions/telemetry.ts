import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelemetry } from "../../src/telemetry/index.js";

/** 采集独立于 session tree 的本地 append-only 工具调用遥测。 */
export default function telemetryExtension(pi: ExtensionAPI): void {
	registerTelemetry(pi);
}
