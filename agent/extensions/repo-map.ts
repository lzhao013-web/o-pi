import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerRepoMapCommand } from "../../src/repo-map/commands.js";

/** 注册显式、session-local 的 /init；加载扩展本身不探测或扫描仓库。 */
export default function repoMapExtension(pi: Pick<ExtensionAPI, "registerCommand" | "appendEntry">): void {
	registerRepoMapCommand(pi);
}
