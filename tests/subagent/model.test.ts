import { describe, expect, it } from "vitest";
import { formatModelReference } from "../../src/subagent/model.js";

describe("subagent model reference", () => {
	it.each([
		[undefined, undefined],
		[{ provider: "openai-codex", id: "gpt-5.4" }, "openai-codex/gpt-5.4"],
	])("formats provider and model ID", (model, expected) => {
		expect(formatModelReference(model)).toBe(expected);
	});
});
