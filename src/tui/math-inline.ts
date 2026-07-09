const COMMAND_REPLACEMENTS = new Map<string, string>([
	["alpha", "α"],
	["beta", "β"],
	["gamma", "γ"],
	["delta", "δ"],
	["epsilon", "ε"],
	["varepsilon", "ε"],
	["theta", "θ"],
	["lambda", "λ"],
	["mu", "μ"],
	["pi", "π"],
	["rho", "ρ"],
	["sigma", "σ"],
	["phi", "φ"],
	["varphi", "φ"],
	["omega", "ω"],
	["Gamma", "Γ"],
	["Delta", "Δ"],
	["Theta", "Θ"],
	["Lambda", "Λ"],
	["Pi", "Π"],
	["Sigma", "Σ"],
	["Phi", "Φ"],
	["Omega", "Ω"],
	["sum", "∑"],
	["prod", "∏"],
	["int", "∫"],
	["partial", "∂"],
	["nabla", "∇"],
	["times", "×"],
	["cdot", "·"],
	["pm", "±"],
	["mp", "∓"],
	["le", "≤"],
	["leq", "≤"],
	["ge", "≥"],
	["geq", "≥"],
	["neq", "≠"],
	["approx", "≈"],
	["equiv", "≡"],
	["infty", "∞"],
	["to", "→"],
	["rightarrow", "→"],
	["leftarrow", "←"],
	["Rightarrow", "⇒"],
	["Leftarrow", "⇐"],
	["in", "∈"],
	["notin", "∉"],
	["subset", "⊂"],
	["subseteq", "⊆"],
	["cup", "∪"],
	["cap", "∩"],
	["sin", "sin"],
	["cos", "cos"],
	["tan", "tan"],
	["log", "log"],
	["ln", "ln"],
	["min", "min"],
	["max", "max"],
	["lim", "lim"],
	["cdots", "⋯"],
	["ldots", "…"],
	["dots", "…"],
]);
const LATEX_COMMAND_PATTERN = /\\([A-Za-z]+)/g;

const TEXT_COMMANDS = ["text", "mathrm", "operatorname", "mathbf", "mathit", "mathsf", "mathtt"];
const SUPERSCRIPT_CHARS: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
};
const SUBSCRIPT_CHARS: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
};
const BLACKBOARD_CHARS: Record<string, string> = {
	C: "ℂ",
	H: "ℍ",
	N: "ℕ",
	P: "ℙ",
	Q: "ℚ",
	R: "ℝ",
	Z: "ℤ",
};

/** 行内公式不能稳定嵌入图片；这里仅做保守文本化，复杂 TeX 回退源码。 */
export function renderInlineMathText(tex: string, mode: "text" | "source"): string {
	const trimmed = tex.trim();
	if (trimmed.length === 0) return "";
	if (mode === "source") return `$${trimmed}$`;

	const textCommand = unwrapSingleTextCommand(trimmed);
	if (textCommand !== undefined) return textCommand;

	let output = trimmed;
	for (const command of TEXT_COMMANDS) output = unwrapCommand(output, command);
	output = replaceMathbb(output);
	output = replaceSimpleFractions(output);
	output = replaceSquareRoots(output);
	output = replaceKnownCommands(output);
	output = replaceScripts(output, "^", SUPERSCRIPT_CHARS);
	output = replaceScripts(output, "_", SUBSCRIPT_CHARS);
	output = output
		.replace(/\\left\b|\\right\b/g, "")
		.replace(/\\[,;:!]/g, " ")
		.replace(/\\[{}]/g, (match) => match.slice(1))
		.replace(/[{}]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (output.length === 0 || /\\[A-Za-z]+/.test(output) || /\\begin\b|\\end\b/.test(output)) return `$${trimmed}$`;
	return output;
}

function replaceKnownCommands(value: string): string {
	return value.replace(LATEX_COMMAND_PATTERN, (match, command: string) => COMMAND_REPLACEMENTS.get(command) ?? match);
}

function replaceMathbb(value: string): string {
	let next = value;
	for (;;) {
		const replaced = next.replace(/\\mathbb\{([A-Za-z])\}/g, (_, char: string) => BLACKBOARD_CHARS[char] ?? char);
		if (replaced === next) return next;
		next = replaced;
	}
}

function unwrapSingleTextCommand(tex: string): string | undefined {
	for (const command of TEXT_COMMANDS) {
		const prefix = `\\${command}{`;
		if (!tex.startsWith(prefix) || !tex.endsWith("}")) continue;
		const inner = tex.slice(prefix.length, -1);
		if (hasBalancedBraces(inner)) return inner;
	}
	return undefined;
}

function unwrapCommand(value: string, command: string): string {
	const pattern = new RegExp(`\\\\${command}\\{([^{}]*)\\}`, "g");
	let next = value;
	for (;;) {
		const replaced = next.replace(pattern, "$1");
		if (replaced === next) return next;
		next = replaced;
	}
}

function replaceSimpleFractions(value: string): string {
	let next = value;
	for (;;) {
		const replaced = next.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2");
		if (replaced === next) return next;
		next = replaced;
	}
}

function replaceSquareRoots(value: string): string {
	let next = value;
	for (;;) {
		const replaced = next
			.replace(/\\sqrt\[3\]\{([^{}]+)\}/g, "∛$1")
			.replace(/\\sqrt\[4\]\{([^{}]+)\}/g, "∜$1")
			.replace(/\\sqrt\{([^{}]+)\}/g, "√$1");
		if (replaced === next) return next;
		next = replaced;
	}
}

function replaceScripts(value: string, marker: "^" | "_", chars: Record<string, string>): string {
	let next = value;
	const escaped = marker === "^" ? "\\^" : "_";
	const bracedPattern = new RegExp(`${escaped}\\{([^{}]+)\\}`, "g");
	const singlePattern = new RegExp(`${escaped}([A-Za-z0-9()+\\-=])`, "g");
	for (;;) {
		const replaced = next.replace(bracedPattern, (match, content: string) => toUnicodeScript(content, chars) ?? match).replace(singlePattern, (match, content: string) => toUnicodeScript(content, chars) ?? match);
		if (replaced === next) return next;
		next = replaced;
	}
}

function toUnicodeScript(value: string, chars: Record<string, string>): string | undefined {
	let output = "";
	for (const char of value.replace(/\s+/g, "")) {
		const replacement = chars[char];
		if (replacement === undefined) return undefined;
		output += replacement;
	}
	return output.length > 0 ? output : undefined;
}

function hasBalancedBraces(value: string): boolean {
	let depth = 0;
	for (const char of value) {
		if (char === "{") depth += 1;
		else if (char === "}") depth -= 1;
		if (depth < 0) return false;
	}
	return depth === 0;
}
