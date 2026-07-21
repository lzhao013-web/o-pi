import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderCodexQuota, renderCodexQuotaError } from "../../src/codex-quota/render.js";
import { CodexQuotaError, type CodexQuotaSnapshot } from "../../src/codex-quota/types.js";

describe("codex quota renderer", () => {
	it.each([100, 42])("宽度 %i 下不产生越界行", (width) => {
		const lines = renderCodexQuota(snapshot(), width);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("错误渲染不暴露底层详情", () => {
		const error = renderCodexQuotaError(new CodexQuotaError("timeout", "secret details"), 42).join("\n");
		expect(error).not.toContain("secret details");
	});

	it("长文本会自动折行，不会裁剪尾部", () => {
		const data = snapshot();
		const bucket = data.buckets[0];
		if (bucket === undefined) {
			throw new Error("snapshot bucket missing");
		}
		data.buckets[0] = {
			id: `${"quota".repeat(20)}ZZZZ_END`,
			name: bucket.name,
			planType: bucket.planType,
			primary: bucket.primary,
			secondary: bucket.secondary,
			credits: bucket.credits,
		};
		const lines = renderCodexQuota(data, 48);
		expect(lines.join(" ")).toContain("ZZZZ_END");
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
	});
});

function snapshot(): CodexQuotaSnapshot {
	return {
		generatedAt: new Date("2026-07-06T00:00:00Z"),
		timeZone: "Asia/Shanghai",
		buckets: [{
			id: "codex",
			name: "Codex",
			planType: "pro",
			primary: { usedPercent: 75, windowDurationMins: 10080, resetsAt: new Date("2026-07-13T00:00:00Z") },
			secondary: undefined,
			credits: { hasCredits: true, unlimited: false, balance: "10" },
		}],
		resetCredits: {
			availableCount: 1,
			credits: [{
				id: "credit-1",
				resetType: "codexRateLimits",
				status: "available",
				grantedAt: new Date("2026-07-01T00:00:00Z"),
				expiresAt: new Date("2026-07-13T00:00:00Z"),
				title: "Full reset",
				description: "Free reset",
			}],
		},
	};
}
