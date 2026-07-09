import { Markdown, resetCapabilitiesCache, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMathMarkdownRenderer, supportsDisplayMathImages, warmDisplayMathRenderer } from "../../src/tui/math-markdown.js";
import type { TuiMathConfig } from "../../src/tui/types.js";

const mathConfig: TuiMathConfig = {
	enabled: true,
	display: true,
	inline: "text",
	max_width_cells: 72,
	max_height_cells: 18,
	svg_scale: 2,
	foreground: "#d4d4d4",
};

const theme = {
	heading: (text: string) => text,
	link: (text: string) => text,
	linkUrl: (text: string) => text,
	code: (text: string) => text,
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	quote: (text: string) => text,
	quoteBorder: (text: string) => text,
	hr: (text: string) => text,
	listBullet: (text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
};

beforeAll(async () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	await warmDisplayMathRenderer();
});

afterEach(() => {
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
});

describe("math markdown renderer", () => {
	it("替换行内公式但不处理 code span 中的美元符号", () => {
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("LLM 输出一个 $\\text{行内公式}$，不是 `$x$`。", 0, 0, theme).render(120).join("\n");

		expect(output).toContain("LLM 输出一个 行内公式");
		expect(output).toContain("$x$");
	});

	it("替换反斜杠括号行内公式但不处理 code span", () => {
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("LLM 输出一个 \\(\\text{行内公式}\\)，不是 `\\(x\\)`。", 0, 0, theme).render(120).join("\n");

		expect(output).toContain("LLM 输出一个 行内公式");
		expect(output).toContain("\\(x\\)");
	});

	it("不把价格里的美元符号误判为行内公式", () => {
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("This costs $5 and $10 tomorrow.", 0, 0, theme).render(120).join("\n");

		expect(output).toContain("This costs $5 and $10 tomorrow.");
	});

	it("不把 shell 环境变量误判为行内公式", () => {
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("Use $PATH and $HOME.", 0, 0, theme).render(120).join("\n");

		expect(output).toContain("Use $PATH and $HOME.");
	});

	it("不把普通转义括号误判为反斜杠括号行内公式", () => {
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("Paren text \\(not latex\\) should stay text.", 0, 0, theme).render(120).join("\n");

		expect(output).toContain("Paren text (not latex) should stay text.");
	});

	it("继续识别有明确数学特征的行内公式", () => {
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("Inline $x+1$ and \\(\\alpha + \\beta\\).", 0, 0, theme).render(120).join("\n");

		expect(output).toContain("Inline x+1 and α + β.");
	});

	it("终端不支持图片时块级公式回退为源码", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("before\n\n$$\nx_i^2\n$$\n\nafter", 0, 0, theme).render(120).join("\n");

		expect(supportsDisplayMathImages()).toBe(false);
		expect(output).toContain("before");
		expect(output).toContain("$$");
		expect(output).toContain("x_i^2");
		expect(output).toContain("after");
	});

	it("识别反斜杠方括号块级公式", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("before\n\n\\[\nx_i^2\n\\]\n\nafter", 0, 0, theme).render(120).join("\n");

		expect(output).toContain("before");
		expect(output).toContain("$$");
		expect(output).toContain("x_i^2");
		expect(output).toContain("after");
	});

	it("识别紧跟普通段落的反斜杠方括号公式", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("**效果：**\n\\[\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n\\]", 0, 0, theme).render(120).join("\n");

		expect(output).toContain("效果");
		expect(output).toContain("\u001b_G");
		expect(output).not.toContain("\\begin{aligned}");
	});

	it("识别行首裸 align 环境", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown(
			"**效果：**\n\\begin{align}\n\\dot{x} &= \\sigma (y - x), \\label{eq:lorenz1} \\\\\n\\dot{y} &= x (\\rho - z) - y, \\label{eq:lorenz2}\n\\end{align}",
			0,
			0,
			theme,
		)
			.render(120)
			.join("\n");

		expect(output).toContain("效果");
		expect(output).toContain("\u001b_G");
		expect(output).not.toContain("\\begin{align}");
	});

	it("不渲染代码块里的反斜杠方括号和裸环境", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("```latex\n\\[\nx_i^2\n\\]\n\\begin{align}\na&=b\n\\end{align}\n```", 0, 0, theme).render(120).join("\n");

		expect(output).not.toContain("\u001b_G");
		expect(output).toContain("\\begin{align}");
		expect(output).toContain("x_i^2");
	});

	it("不渲染普通文本中的转义方括号", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("普通文字里提到 \\[x_i^2\\] 不应该变成块级图片。", 0, 0, theme).render(120).join("\n");

		expect(output).not.toContain("\u001b_G");
		expect(output).toContain("[x_i^2]");
	});

	it("不渲染普通文本中的裸 LaTeX 环境片段", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("普通文字提到 \\begin{align}\na&=b\n\\end{align} 这个环境。", 0, 0, theme).render(120).join("\n");

		expect(output).not.toContain("\u001b_G");
		expect(output).toContain("\\begin{align}");
	});

	it("终端支持图片时块级公式渲染为 Kitty 图片序列", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("$$\nx_i^2\n$$", 0, 0, theme).render(120).join("\n");

		expect(supportsDisplayMathImages()).toBe(true);
		expect(output).toContain("\u001b_G");
		expect(output).not.toContain("x_i^2");
	});

	it("终端支持 iTerm2 图片协议时块级公式渲染为 iTerm2 图片序列", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("$$\nx_i^2\n$$", 0, 0, theme).render(120).join("\n");

		expect(supportsDisplayMathImages()).toBe(true);
		expect(output).toContain("\u001b]1337;File=");
		expect(output).not.toContain("\u001b_G");
		expect(output).not.toContain("x_i^2");
	});

	it("块级公式按自然尺寸显示，不放大到全局上限", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		installMathMarkdownRenderer(mathConfig);
		const lines = new Markdown("$$\na^2 + b^2 = c^2\n$$", 0, 0, theme).render(120);

		expect(lines.length).toBeLessThan(8);
		expect(lines.join("\n")).toContain("\u001b_G");
	});

	it("长公式使用可用宽度，复杂分式保留多行占位", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		installMathMarkdownRenderer({ ...mathConfig, max_width_cells: 120 });
		const fourier = new Markdown(
			"$$\nf(x) = a_0 + \\sum_{n=1}^{\\infty} \\left( a_n \\cos\\frac{n\\pi x}{L} + b_n \\sin\\frac{n\\pi x}{L} \\right) + \\sum_{n=1}^{\\infty} \\left( c_n \\cos\\frac{2n\\pi x}{L} + d_n \\sin\\frac{2n\\pi x}{L} \\right)\n$$",
			0,
			0,
			theme,
		).render(120);
		const bayes = new Markdown("$$\nP(A \\mid B) = \\frac{P(B \\mid A) \\, P(A)}{P(B)}\n$$", 0, 0, theme).render(120);
		const fourierSize = parseKittySize(fourier.join("\n"));
		const bayesSize = parseKittySize(bayes.join("\n"));

		expect(fourierSize?.columns).toBeGreaterThan(72);
		expect(fourierSize?.columns).toBeLessThanOrEqual(120);
		expect(bayesSize?.rows).toBeGreaterThanOrEqual(4);
	});

	it("终端支持图片时反斜杠方括号公式渲染为 Kitty 图片序列", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		installMathMarkdownRenderer(mathConfig);
		const output = new Markdown("\\[\nx_i^2\n\\]", 0, 0, theme).render(120).join("\n");

		expect(output).toContain("\u001b_G");
		expect(output).not.toContain("x_i^2");
	});
});

function parseKittySize(output: string): { columns: number; rows: number } | undefined {
	const params = output.match(/\u001b_G([^;]+);/)?.[1];
	if (params === undefined) return undefined;
	const values = new Map(params.split(",").map((part) => part.split("=", 2) as [string, string]));
	const columns = Number(values.get("c"));
	const rows = Number(values.get("r"));
	return Number.isFinite(columns) && Number.isFinite(rows) ? { columns, rows } : undefined;
}
