import { describe, expect, it, vi } from "vitest";
import { renderDisplayMathImage, warmMathRenderer } from "../../src/tui/math-renderer.js";
import type { TuiMathConfig } from "../../src/tui/types.js";

const mathConfig: TuiMathConfig = {
	enabled: true,
	display: true,
	inline: "text",
	max_width_cells: 120,
	max_height_cells: 18,
	svg_scale: 2,
	foreground: "#d4d4d4",
};

describe("math renderer", () => {
	it("预热动态字体后渲染 mathbb 和 aligned 公式", async () => {
		await warmMathRenderer();

		const image = renderDisplayMathImage(
			String.raw`\begin{aligned}
\mathbb{P}(A \cap B \mid C) &= \frac{\mathbb{P}(A \cap B \cap C)}{\mathbb{P}(C)} \\
&= \frac{\mathbb{P}(A \mid B \cap C) \, \mathbb{P}(B \cap C)}{\mathbb{P}(C)} \\
&= \mathbb{P}(A \mid B \cap C) \, \mathbb{P}(B \mid C)
\end{aligned}`,
			mathConfig,
		);

		expect(image?.base64.length).toBeGreaterThan(0);
		expect(image?.widthPx).toBeGreaterThan(0);
		expect(image?.heightPx).toBeGreaterThan(100);
	});

	it("渲染 mathbb 不向终端输出 bboldx variant 警告", async () => {
		await warmMathRenderer();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const image = renderDisplayMathImage(String.raw`\mathbb{R}`, mathConfig);

			expect(image?.base64.length).toBeGreaterThan(0);
			expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Invalid variant: -bboldx"));
		} finally {
			warn.mockRestore();
		}
	});

	it("渲染包含字面量小于号的 cases 公式", async () => {
		await warmMathRenderer();

		const image = renderDisplayMathImage(
			String.raw`P(r, \theta) =
\begin{cases}
\displaystyle
\frac{1}{\pi a^2} \sum _{m=-\infty}^{\infty} \sum _{n=1}^{\infty}
\frac{J_m(\lambda_{mn} r / a)}{J_{m+1}(\lambda_{mn})^2}
e^{i m \theta}, & 0 \le r < a, \\[12pt]
0, & r \ge a,
\end{cases}`,
			mathConfig,
		);

		expect(image?.base64.length).toBeGreaterThan(0);
		expect(image?.widthPx).toBeGreaterThan(100);
		expect(image?.heightPx).toBeGreaterThan(100);
	});

	it("渲染 cancel 和 boldsymbol 扩展命令", async () => {
		await warmMathRenderer();

		const standardModel = renderDisplayMathImage(
			String.raw`\begin{aligned}
\mathcal{L}_{SM} &= -\frac{1}{4}F^a_{\mu\nu}F^{a\mu\nu} + i\bar{\psi}\cancel{D}\psi + (D_\mu\Phi)^\dagger(D^\mu\Phi)-V(\Phi) \\
&+ \sum_f(-m_f\bar{\psi}_f\psi_f+\mathrm{h.c.}) + \frac{g_s}{2\sqrt{2}}\bar{q}\gamma^\mu T^aG^a_\mu q
\end{aligned}`,
			mathConfig,
		);
		const vae = renderDisplayMathImage(
			String.raw`\begin{aligned}
\mathcal{L}(\theta,\phi;\mathbf{x}) &= \mathbb{E}_{q_\phi(\mathbf{z}|\mathbf{x})}[\log p_\theta(\mathbf{x}|\mathbf{z})] - D_{KL}(q_\phi(\mathbf{z}|\mathbf{x}) \parallel p(\mathbf{z})) \\
q_\phi(\mathbf{z}|\mathbf{x}) &= \mathcal{N}(\mathbf{z}; \boldsymbol{\mu}, \boldsymbol{\sigma}^2\mathbf{I})
\end{aligned}`,
			mathConfig,
		);

		expect(standardModel?.base64.length).toBeGreaterThan(0);
		expect(standardModel?.widthPx).toBeGreaterThan(100);
		expect(standardModel?.heightPx).toBeGreaterThan(60);
		expect(vae?.base64.length).toBeGreaterThan(0);
		expect(vae?.widthPx).toBeGreaterThan(100);
		expect(vae?.heightPx).toBeGreaterThan(60);
	});

	it("渲染保留的常见扩展包命令", async () => {
		await warmMathRenderer();

		const image = renderDisplayMathImage(
			String.raw`\begin{aligned}
\braket{\psi|\phi} \qquad
\qty(\frac{a}{b}) \qquad
\centernot{\implies} \qquad
\upmu\mathrm{m} \qquad
45\degree
\end{aligned}`,
			mathConfig,
		);

		expect(image?.base64.length).toBeGreaterThan(0);
		expect(image?.widthPx).toBeGreaterThan(100);
		expect(image?.heightPx).toBeGreaterThan(0);
	});
});
