import type { Theme } from "@earendil-works/pi-coding-agent";
import { BorderedScrollViewer } from "../tui/bordered-scroll-viewer.js";
import { renderCodexResetCardError, renderCodexResetCards } from "./render.js";
import type { CodexResetCardSnapshot } from "./types.js";

const BODY_ROWS_RATIO = 0.65;

/** /codex-reset-card 的只读浮层；查询结果只渲染到 UI，不写入模型上下文或会话历史。 */
export class CodexResetCardViewer extends BorderedScrollViewer {
	constructor(
		private readonly result: CodexResetCardSnapshot | Error,
		theme: Pick<Theme, "fg">,
		getRows: () => number,
		done: () => void,
	) {
		super(theme, getRows, done, BODY_ROWS_RATIO, false);
	}

	protected renderLines(width: number): string[] {
		return this.result instanceof Error ? renderCodexResetCardError(this.result, width) : renderCodexResetCards(this.result, width);
	}
}
