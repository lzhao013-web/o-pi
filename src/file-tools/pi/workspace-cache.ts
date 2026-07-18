import { clearFileToolsConfigCache } from "../config.js";
import { defaultIgnoreEngine } from "../ignore/ignore-engine.js";

/** 释放文件工具跨调用缓存；由加载过对应 adapter 的扩展在退出时调用。 */
export function disposeFileToolsCaches(): void {
	clearFileToolsConfigCache();
	defaultIgnoreEngine.invalidate();
}
