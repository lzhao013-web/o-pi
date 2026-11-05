import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../../../../helpers/fixture.ts";
import { configureModel } from "../../../../helpers/model-fixture.ts";
import { startModelServer } from "../../../../../cli/model-server.ts";
import type { Plan } from "../../../../../../plugins/orchestrator/schema.ts";

const plan: Plan = { concurrency: 3, stages: [
	{ mode: "parallel", calls: [
		{ id: "files", tool: "find", args: { query: ".txt", glob: "*.txt" } },
		{ id: "empty", tool: "find", args: { query: "no-such-file-xyz" } },
	] },
	{ mode: "parallel", calls: [
		{ id: "bodies", tool: "read", map: { from: "files.data.matches", limit: 2 }, args: { path: { $ref: "$item.path" } }, when: { op: "nonempty", ref: "files.data.matches" } },
		{ id: "slow", tool: "read", args: { path: "slow.txt" } },
		{ id: "skipped", tool: "read", args: { path: "missing.txt" }, when: { op: "nonempty", ref: "empty.data.matches" } },
	] },
	{ mode: "serial", calls: [{ id: "listing", tool: "ls", args: {} }] },
] };

test.describe("编排器执行视图", () => {
	let model: Awaited<ReturnType<typeof startModelServer>>;
	test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
		model = await startModelServer((request) => request.messages.some((message) => message.role === "tool")
			? { text: "编排验证完成" } : { tool: "orchestrate", args: plan });
		await writeFile(path.join(cwd, "a.txt"), ("orchestrator-a " + "x".repeat(24) + "\n").repeat(1000));
		await writeFile(path.join(cwd, "b.txt"), ("orchestrator-b " + "y".repeat(24) + "\n").repeat(1000));
		await writeFile(path.join(cwd, "slow.txt"), "delayed result\n");
		await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
		await mkdir(path.join(agentDir, "extensions"), { recursive: true });
		await writeFile(path.join(agentDir, "extensions", "wait-for-ui.ts"), `
			import { existsSync } from "node:fs";
			import { join } from "node:path";
			export default (pi) => pi.on("tool_call", async (event, ctx) => {
				if (event.parentToolCallId && event.toolName === "read" && event.input.path === "slow.txt") {
					for (let attempt = 0; attempt < 800 && !existsSync(join(ctx.cwd, "release")) && !ctx.signal?.aborted; attempt++) {
						await new Promise(resolve => setTimeout(resolve, 25));
					}
				}
			});
		`);
		await configureModel(agentDir, model.url, "fixture", { reasoning: false, settings: {
			extensions: [path.resolve("plugins/orchestrator/index.ts")], defaultTools: ["orchestrate", "read", "find", "ls"],
		} });
	});
	test.afterEach(async () => { await model?.close(); });

	test("搜索后动态映射、条件跳过、大载荷与历史恢复，支持深浅主题和窄屏", async ({ gui: { page }, workspace: { cwd, agentDir } }, info) => {
		await page.emulateMedia({ colorScheme: "light" });
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("运行查询编排");
		await editor.press("ControlOrMeta+Enter");
		const tool = page.locator('[data-tool="orchestrate"]');
		const slow = tool.locator('[data-operation-id="slow"]');
		const body = tool.locator('[data-operation-id="bodies/0"]');
		try {
			await expect(slow).toHaveAttribute("data-state", "running");
			await expect(body).toHaveAttribute("data-state", "completed");
			await expect(tool.locator(".orchestrator-map-items > li")).toHaveCount(2);
			await expect(tool.locator(".orchestrator-map-body > .tool-note")).toContainText("仅处理前 2 项");
			await expect(tool.locator('[data-operation-id="bodies/1"]')).toHaveAttribute("data-state", "completed");
			await expect(tool.locator('[data-operation-id="skipped"]')).toHaveAttribute("data-state", "skipped");
			await expect(tool.locator('[data-operation-id="skipped"] .orchestrator-reason')).toHaveText("条件不满足");
			await expect(tool.locator('[data-operation-id="listing"]')).toHaveAttribute("data-state", "pending");
			await body.locator(".orchestrator-operation-trigger").click();
			await expect(body.locator(".orchestrator-operation-details")).toContainText("orchestrator-a");
			await body.getByRole("button", { name: "调用参数", exact: true }).click();
			await expect(body.locator(".parameter-fields")).toContainText("a.txt");
			await body.locator(".orchestrator-operation-trigger").click();
			for (const colorScheme of ["light", "dark"] as const) {
				await writeFile(path.join(agentDir, "configs", "gui.jsonc"), JSON.stringify({ theme: colorScheme }));
				await page.evaluate(() => window.dispatchEvent(new Event("focus")));
				await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
				await tool.screenshot({ path: info.outputPath(`orchestrator-${colorScheme}.png`) });
			}
			for (const fontSize of ["100%", "200%"]) {
				await page.evaluate((value) => { document.documentElement.style.fontSize = value; }, fontSize);
				const layout = await tool.locator(".orchestrator-flow").evaluate((flow) => {
					const container = flow.getBoundingClientRect();
					return Array.from(flow.querySelectorAll(".orchestrator-operation")).every((node) => {
						const bounds = node.getBoundingClientRect();
						return bounds.left >= container.left - 1 && bounds.right <= container.right + 1;
					});
				});
				expect(layout).toBe(true);
			}
			await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
			const parallel = tool.locator(".orchestrator-stage-calls").nth(1);
			const columns = await parallel.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
			if (info.project.name === "phone") expect(columns).toBe(1);
			else expect(columns).toBeGreaterThan(1);
		} finally { await writeFile(path.join(cwd, "release"), "ready"); }
		await expect(page.locator(".reply-answer")).toContainText("编排验证完成");
		await page.reload();
		await expect(page.locator(".reply-answer")).toContainText("编排验证完成");
		await page.locator(".assistant-reply .reply-activity > .disclosure-trigger").click();
		await tool.locator(":scope > [data-slot=collapsible] > .activity-summary").click();
		await expect(body).toHaveAttribute("data-state", "completed");
		await expect(slow).toHaveAttribute("data-state", "completed");
		await expect(tool.locator('[data-operation-id="listing"]')).toHaveAttribute("data-state", "completed");
		await expect(tool.locator('[data-operation-id="skipped"]')).toHaveAttribute("data-state", "skipped");
		await body.locator(".orchestrator-operation-trigger").click();
		await expect(body.locator(".orchestrator-operation-details")).toContainText("orchestrator-a");
		await expect(body.locator(".orchestrator-duration")).toHaveText(/\d+ ms/);
		expect(JSON.stringify(model.requests.at(-1)?.messages.filter((message) => message.role === "tool"))).not.toContain("invocation");
	});
});
