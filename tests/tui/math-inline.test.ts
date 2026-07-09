import { describe, expect, it } from "vitest";
import { renderInlineMathText } from "../../src/tui/math-inline.js";

describe("math inline rendering", () => {
	it("将简单 text 命令转成行内文本", () => {
		expect(renderInlineMathText("\\text{行内公式}", "text")).toBe("行内公式");
	});

	it("将常见符号转成 unicode 近似文本", () => {
		expect(renderInlineMathText("\\alpha + \\beta \\leq \\gamma", "text")).toBe("α + β ≤ γ");
	});

	it("将根号转成 unicode 近似文本", () => {
		expect(renderInlineMathText("\\sqrt{x} + \\sqrt[3]{y}", "text")).toBe("√x + ∛y");
	});

	it("将简单上下标转成 unicode 近似文本", () => {
		expect(renderInlineMathText("x_i^2 + a_{n+1}", "text")).toBe("xᵢ² + aₙ₊₁");
	});

	it("将常见分式和集合符号转成 unicode 近似文本", () => {
		expect(renderInlineMathText("\\frac{1}{2}\\in\\mathbb{R}", "text")).toBe("1/2∈ℝ");
	});

	it("未知命令保留源码", () => {
		expect(renderInlineMathText("\\unknown{x}", "text")).toBe("$\\unknown{x}$");
	});

	it("source 模式保留公式源码", () => {
		expect(renderInlineMathText("\\text{行内公式}", "source")).toBe("$\\text{行内公式}$");
	});
});
