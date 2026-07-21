import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails } from "./types.js";

export function registerSkillMessageRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
	pi.registerMessageRenderer<SkillLoadDetails>(SKILL_CONTEXT_MESSAGE, (message, { expanded }, theme) => {
		return renderSkillDetails(message.details, expanded, theme);
	});
}

export function renderSkillCall(name: string, theme: Theme): Text {
	return new Text(
		theme.fg("customMessageLabel", `${theme.bold("[skill]")} `) + theme.fg("customMessageText", name),
		0,
		0,
	);
}

export function renderSkillDetails(details: SkillLoadDetails | undefined, expanded: boolean, theme: Theme): Box {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const name = details?.name ?? "skill";
	const status = details?.deduplicated ? "already disclosed" : "loaded";
	box.addChild(new Text(
		theme.fg("customMessageLabel", `${theme.bold("[skill]")} `)
			+ theme.fg("customMessageText", name)
			+ theme.fg("success", ` ${status}`),
		0,
		0,
	));
	if (expanded && details !== undefined) {
		box.addChild(new Text(theme.fg("dim", `  ${details.scope} · ${details.loadedBy} · ${details.chars} chars`), 0, 0));
	}
	return box;
}
