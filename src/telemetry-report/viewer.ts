import type { Theme } from "@earendil-works/pi-coding-agent";

import { BorderedScrollViewer } from "../tui/bordered-scroll-viewer.js";
import type { LiveTelemetryReport } from "./live.js";
import { renderLiveTelemetry } from "./render-tui.js";

const VIEWER_BODY_ROWS_RATIO = 0.82;

export class TelemetryViewer extends BorderedScrollViewer {
	constructor(
		private readonly report: LiveTelemetryReport,
		theme: Pick<Theme, "fg">,
		getRows: () => number,
		done: () => void,
	) {
		super(theme, getRows, done, VIEWER_BODY_ROWS_RATIO, true);
	}

	protected renderLines(width: number): string[] {
		return renderLiveTelemetry(this.report, width);
	}
}
