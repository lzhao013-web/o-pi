import { Markdown, Text, allocateImageId, encodeITerm2, encodeKitty, getCapabilities, getCellDimensions, type Component } from "@earendil-works/pi-tui";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { renderInlineMathText } from "./math-inline.js";
import type { TuiMathConfig } from "./types.js";

type MarkdownRender = (this: Markdown, width: number) => string[];
type MathRendererModule = typeof import("./math-renderer.js");
type SupportedImageProtocol = "kitty" | "iterm2";

interface Point {
	offset?: number;
}

interface PositionedNode {
	type: string;
	value?: string;
	children?: PositionedNode[];
	position?: {
		start: Point;
		end: Point;
	};
}

interface MarkdownInternals {
	text: string;
	paddingX: number;
	paddingY: number;
	defaultTextStyle?: ConstructorParameters<typeof Markdown>[4];
	theme: ConstructorParameters<typeof Markdown>[3];
	options?: ConstructorParameters<typeof Markdown>[5];
}

type MathRange = { start: number; end: number; value: string };
interface MathAnalysis {
	displayBlocks: MathRange[];
	inlineRanges: MathRange[];
}
interface MathAwareRenderCache {
	source: string;
	cacheKey: string;
	lines: string[];
}

const BARE_DISPLAY_ENV_PATTERN = /\\begin\{(align\*?|aligned|alignedat|alignat\*?|equation\*?|gather\*?|multline\*?|split)\}/g;
const ANALYSIS_CACHE_LIMIT = 128;
const MAX_CACHED_SOURCE_CHARS = 20_000;

let installed = false;
let activeConfig: TuiMathConfig | undefined;
let originalRender: MarkdownRender | undefined;
let mathRendererModule: MathRendererModule | undefined;
let mathRendererImport: Promise<MathRendererModule> | undefined;

const parser = unified().use(remarkParse).use(remarkMath);
const analysisCache = new Map<string, MathAnalysis | undefined>();
const renderCache = new WeakMap<Markdown, MathAwareRenderCache>();

export function installMathMarkdownRenderer(config: TuiMathConfig): void {
	activeConfig = config;
	if (installed) return;
	installed = true;
	originalRender = Markdown.prototype.render;
	Markdown.prototype.render = function patchedMarkdownRender(width: number): string[] {
		const render = originalRender;
		const config = activeConfig;
		if (render === undefined || config === undefined || !config.enabled) return render?.call(this, width) ?? [];
		return renderMathAwareMarkdown(this, width, config, render);
	};
}

export async function warmDisplayMathRenderer(): Promise<void> {
	if (!supportsDisplayMathImages()) return;
	const module = await loadMathRenderer();
	await module.warmMathRenderer();
}

export function supportsDisplayMathImages(): boolean {
	return getSupportedImageProtocol() !== undefined;
}

function renderMathAwareMarkdown(markdown: Markdown, width: number, config: TuiMathConfig, render: MarkdownRender): string[] {
	const internals = markdown as unknown as MarkdownInternals;
	const source = internals.text ?? "";
	if (!hasPotentialMath(source)) return render.call(markdown, width);

	const analysis = analyzeMath(source);
	if (analysis === undefined || (analysis.displayBlocks.length === 0 && analysis.inlineRanges.length === 0)) return render.call(markdown, width);
	const cacheKey = getRenderCacheKey(width, config, analysis);
	const cached = cacheKey !== undefined ? renderCache.get(markdown) : undefined;
	if (cached !== undefined && cached.source === source && cached.cacheKey === cacheKey) return cached.lines;

	const finish = (lines: string[]): string[] => {
		if (cacheKey !== undefined) renderCache.set(markdown, { source, cacheKey, lines });
		return lines;
	};

	if (analysis.displayBlocks.length === 0) {
		const inlineOnly = replaceInlineMathInRange(source, 0, source.length, analysis.inlineRanges, config.inline);
		if (inlineOnly === source) return render.call(markdown, width);
		return finish(renderMarkdownSource(inlineOnly, internals, width, render));
	}

	const lines: string[] = [];
	let cursor = 0;
	for (const block of analysis.displayBlocks) {
		if (block.start < cursor) continue;
		if (block.start > cursor) {
			const markdownSource = replaceInlineMathInRange(source, cursor, block.start, analysis.inlineRanges, config.inline);
			lines.push(...renderMarkdownSource(markdownSource, internals, width, render));
		}
		lines.push(...new DisplayMathComponent(block.value, internals.paddingX, config).render(width));
		cursor = block.end;
	}
	if (cursor < source.length) {
		const markdownSource = replaceInlineMathInRange(source, cursor, source.length, analysis.inlineRanges, config.inline);
		lines.push(...renderMarkdownSource(markdownSource, internals, width, render));
	}
	return finish(lines.length > 0 ? lines : render.call(markdown, width));
}

function getRenderCacheKey(width: number, config: TuiMathConfig, analysis: MathAnalysis): string | undefined {
	if (analysis.displayBlocks.length > 0 && config.display && getSupportedImageProtocol() !== undefined) return undefined;
	return [
		width,
		config.display ? "display" : "source",
		config.inline,
		config.max_width_cells,
		config.max_height_cells,
		config.svg_scale,
		config.foreground,
		getSupportedImageProtocol() ?? "none",
	].join("\0");
}

function renderMarkdownSource(source: string, internals: MarkdownInternals, width: number, render: MarkdownRender): string[] {
	if (source.trim().length === 0) return [];
	const next = new Markdown(source, internals.paddingX, internals.paddingY, internals.theme, internals.defaultTextStyle, internals.options);
	return render.call(next, width);
}

function analyzeMath(source: string): MathAnalysis | undefined {
	const cached = analysisCache.get(source);
	if (cached !== undefined || analysisCache.has(source)) return cached;
	const analysis = parseMathAnalysis(source);
	setCachedAnalysis(source, analysis);
	return analysis;
}

function parseMathAnalysis(source: string): MathAnalysis | undefined {
	let root: PositionedNode;
	try {
		root = parser.parse(source) as PositionedNode;
	} catch {
		return undefined;
	}
	const children = root.children ?? [];
	const protectedRanges = collectProtectedRanges(root);
	const dollarBlocks = children
		.filter((child) => child.type === "math")
		.map((child) => {
			const start = child.position?.start.offset;
			const end = child.position?.end.offset;
			return typeof start === "number" && typeof end === "number" ? { start, end, value: child.value ?? "" } : undefined;
		})
		.filter((block): block is MathRange => block !== undefined);
	const bracketBlocks = parseDelimitedDisplayMath(source, "\\[", "\\]", [...protectedRanges, ...dollarBlocks]);
	const bareEnvironmentBlocks = parseBareDisplayEnvironments(source, [...protectedRanges, ...dollarBlocks, ...bracketBlocks]);
	const displayBlocks = [...dollarBlocks, ...bracketBlocks, ...bareEnvironmentBlocks].sort((left, right) => left.start - right.start);
	const inlineRanges: MathRange[] = [];
	visit(root, (node) => {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (typeof start !== "number" || typeof end !== "number") return;
		if (node.type === "inlineMath") {
			const value = node.value ?? "";
			if (isLikelyInlineLatex(value)) inlineRanges.push({ start, end, value });
			return;
		}
		if (node.type === "text") inlineRanges.push(...parseBracketInlineMath(source, start, end));
	});
	return {
		displayBlocks,
		inlineRanges: inlineRanges
			.filter((range) => !overlapsAny(protectedRanges, range.start, range.end))
			.filter((range) => !overlapsAny(displayBlocks, range.start, range.end))
			.sort((left, right) => left.start - right.start),
	};
}

function setCachedAnalysis(source: string, analysis: MathAnalysis | undefined): void {
	if (source.length > MAX_CACHED_SOURCE_CHARS) return;
	if (analysisCache.size >= ANALYSIS_CACHE_LIMIT) {
		const oldest = analysisCache.keys().next().value;
		if (oldest !== undefined) analysisCache.delete(oldest);
	}
	analysisCache.set(source, analysis);
}

function collectProtectedRanges(root: PositionedNode): MathRange[] {
	const ranges: MathRange[] = [];
	visit(root, (node) => {
		if (node.type !== "code" && node.type !== "inlineCode") return;
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (typeof start === "number" && typeof end === "number") ranges.push({ start, end, value: "" });
	});
	return ranges;
}

function parseDelimitedDisplayMath(source: string, openDelimiter: string, closeDelimiter: string, protectedRanges: MathRange[]): MathRange[] {
	const ranges: MathRange[] = [];
	let cursor = 0;
	while (cursor < source.length) {
		const open = source.indexOf(openDelimiter, cursor);
		if (open === -1) break;
		const protectedRange = rangeAt(protectedRanges, open);
		if (protectedRange !== undefined) {
			cursor = protectedRange.end;
			continue;
		}
		if (!isLineStart(source, open)) {
			cursor = open + openDelimiter.length;
			continue;
		}
		const close = source.indexOf(closeDelimiter, open + openDelimiter.length);
		if (close === -1) break;
		const end = close + closeDelimiter.length;
		if (!isLineEnd(source, end) || overlapsAny(protectedRanges, open, end)) {
			cursor = end;
			continue;
		}
		ranges.push({
			start: open,
			end,
			value: source.slice(open + openDelimiter.length, close).trim(),
		});
		cursor = end;
	}
	return ranges;
}

function parseBareDisplayEnvironments(source: string, protectedRanges: MathRange[]): MathRange[] {
	const ranges: MathRange[] = [];
	BARE_DISPLAY_ENV_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = BARE_DISPLAY_ENV_PATTERN.exec(source)) !== null) {
		const start = match.index;
		const env = match[1];
		if (env === undefined) continue;
		const protectedRange = rangeAt(protectedRanges, start);
		if (protectedRange !== undefined) {
			BARE_DISPLAY_ENV_PATTERN.lastIndex = protectedRange.end;
			continue;
		}
		if (!isLineStart(source, start)) continue;
		const endToken = `\\end{${env}}`;
		const endStart = source.indexOf(endToken, BARE_DISPLAY_ENV_PATTERN.lastIndex);
		if (endStart === -1) continue;
		const end = endStart + endToken.length;
		if (!isLineEnd(source, end) || overlapsAny(protectedRanges, start, end)) continue;
		ranges.push({ start, end, value: source.slice(start, end).trim() });
		BARE_DISPLAY_ENV_PATTERN.lastIndex = end;
	}
	return ranges;
}

function replaceInlineMathInRange(source: string, start: number, end: number, ranges: MathRange[], mode: TuiMathConfig["inline"]): string {
	let rangeIndex = firstRangeEndingAfter(ranges, start);
	if (rangeIndex >= ranges.length || (ranges[rangeIndex]?.start ?? Number.POSITIVE_INFINITY) >= end) return source.slice(start, end);

	let cursor = start;
	const parts: string[] = [];
	let changed = false;
	for (let index = rangeIndex; index < ranges.length; index += 1) {
		const range = ranges[index];
		if (range === undefined || range.start >= end) break;
		if (range.start < cursor || range.end > end) continue;
		parts.push(source.slice(cursor, range.start), renderInlineMathText(range.value, mode));
		cursor = range.end;
		changed = true;
	}
	if (!changed) return source.slice(start, end);
	parts.push(source.slice(cursor, end));
	return parts.join("");
}

function firstRangeEndingAfter(ranges: MathRange[], offset: number): number {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const range = ranges[mid];
		if (range !== undefined && range.end <= offset) low = mid + 1;
		else high = mid;
	}
	return low;
}

function parseBracketInlineMath(source: string, start: number, end: number): MathRange[] {
	const raw = source.slice(start, end);
	const ranges: MathRange[] = [];
	let cursor = 0;
	while (cursor < raw.length) {
		const open = raw.indexOf("\\(", cursor);
		if (open === -1) break;
		const close = raw.indexOf("\\)", open + 2);
		if (close === -1) break;
		const value = raw.slice(open + 2, close);
		if (isLikelyInlineLatex(value)) {
			ranges.push({
				start: start + open,
				end: start + close + 2,
				value,
			});
		}
		cursor = close + 2;
	}
	return ranges;
}

function isLikelyInlineLatex(value: string): boolean {
	const tex = value.trim();
	if (tex.length === 0 || /\n/.test(tex)) return false;
	if (/\\[A-Za-z]+/.test(tex)) return true;
	if (/[=<>≤≥≠≈≡∈∉⊂⊆∪∩∞∑∏∫√]/.test(tex)) return true;
	if (/(?:^|[^\\])[\^_](?:[A-Za-z0-9]|\\[A-Za-z]+|\{[^{}]+\})/.test(tex)) return true;
	if (/[A-Za-z0-9})]\s*(?:[+\-*]|->|<-|=>)\s*[A-Za-z0-9({\\]/.test(tex)) return true;
	if (/[A-Za-z0-9})]\/[A-Za-z0-9({\\]/.test(tex)) return true;
	if (/^[A-Za-z]$/.test(tex)) return true;
	if (/^[A-Za-z]\s*\(\s*[A-Za-z](?:\s*,\s*[A-Za-z])*\s*\)$/.test(tex)) return true;
	return false;
}

function visit(node: PositionedNode, callback: (node: PositionedNode) => void): void {
	callback(node);
	for (const child of node.children ?? []) visit(child, callback);
}

function hasPotentialMath(source: string): boolean {
	if (hasPotentialDollarMath(source)) return true;
	if (hasPotentialBracketInlineMath(source)) return true;
	return source.includes("\\[") || source.includes("\\begin{");
}

function hasPotentialDollarMath(source: string): boolean {
	let cursor = 0;
	while (cursor < source.length) {
		const open = source.indexOf("$", cursor);
		if (open === -1) return false;
		if (isEscaped(source, open)) {
			cursor = open + 1;
			continue;
		}
		if (source[open + 1] === "$") return true;
		const close = nextUnescaped(source, "$", open + 1);
		if (close === -1) return false;
		if (isLikelyInlineLatex(source.slice(open + 1, close))) return true;
		cursor = close + 1;
	}
	return false;
}

function hasPotentialBracketInlineMath(source: string): boolean {
	let cursor = 0;
	while (cursor < source.length) {
		const open = source.indexOf("\\(", cursor);
		if (open === -1) return false;
		const close = source.indexOf("\\)", open + 2);
		if (close === -1) return false;
		if (isLikelyInlineLatex(source.slice(open + 2, close))) return true;
		cursor = close + 2;
	}
	return false;
}

function nextUnescaped(source: string, token: string, start: number): number {
	let cursor = start;
	for (;;) {
		const index = source.indexOf(token, cursor);
		if (index === -1 || !isEscaped(source, index)) return index;
		cursor = index + token.length;
	}
}

function isEscaped(source: string, offset: number): boolean {
	let slashCount = 0;
	for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) slashCount += 1;
	return slashCount % 2 === 1;
}

function rangeAt(ranges: MathRange[], offset: number): MathRange | undefined {
	return ranges.find((range) => offset >= range.start && offset < range.end);
}

function overlapsAny(ranges: MathRange[], start: number, end: number): boolean {
	return ranges.some((range) => start < range.end && end > range.start);
}

function isLineStart(source: string, offset: number): boolean {
	const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
	return source.slice(lineStart, offset).trim().length === 0;
}

function isLineEnd(source: string, offset: number): boolean {
	const lineEnd = source.indexOf("\n", offset);
	const rest = source.slice(offset, lineEnd === -1 ? source.length : lineEnd);
	return rest.trim().length === 0;
}

class DisplayMathComponent implements Component {
	private imageId: number | undefined;

	constructor(
		private readonly tex: string,
		private readonly paddingX: number,
		private readonly config: TuiMathConfig,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const imageProtocol = getSupportedImageProtocol();
		if (!this.config.display || imageProtocol === undefined) return this.renderSource(width);
		const renderer = mathRendererModule;
		if (renderer === undefined) {
			void warmDisplayMathRenderer();
			return this.renderSource(width);
		}
		const image = renderer.renderDisplayMathImage(this.tex, this.config);
		if (image === undefined) return this.renderSource(width);
		const imageCells = displayImageCells(image.widthPx, image.heightPx, Math.max(1, width - this.paddingX), this.config);
		const prefix = " ".repeat(this.paddingX);
		if (imageProtocol === "kitty") {
			this.imageId ??= allocateImageId();
			const sequence = encodeKitty(image.base64, {
				columns: imageCells.columns,
				rows: imageCells.rows,
				imageId: this.imageId,
				moveCursor: false,
			});
			return [prefix + sequence, ...Array.from({ length: imageCells.rows - 1 }, () => "")];
		}
		const sequence = encodeITerm2(image.base64, {
			width: imageCells.columns,
			height: imageCells.rows,
			preserveAspectRatio: true,
			inline: true,
		});
		const rowOffset = imageCells.rows - 1;
		const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
		return [...Array.from({ length: rowOffset }, () => ""), prefix + moveUp + sequence];
	}

	private renderSource(width: number): string[] {
		const text = `$$\n${this.tex}\n$$`;
		return new Text(text, this.paddingX, 0).render(width);
	}
}

function getSupportedImageProtocol(): SupportedImageProtocol | undefined {
	const protocol = getCapabilities().images;
	return protocol === "kitty" || protocol === "iterm2" ? protocol : undefined;
}

async function loadMathRenderer(): Promise<MathRendererModule> {
	if (mathRendererModule !== undefined) return mathRendererModule;
	mathRendererImport ??= import("./math-renderer.js").then((module) => {
		mathRendererModule = module;
		return module;
	});
	return mathRendererImport;
}

function displayImageCells(widthPx: number, heightPx: number, availableWidth: number, config: TuiMathConfig): { columns: number; rows: number } {
	const cell = getCellDimensions();
	const maxWidthPx = Math.max(1, Math.min(config.max_width_cells, availableWidth) * cell.widthPx);
	const maxHeightPx = Math.max(1, config.max_height_cells * cell.heightPx);
	const scale = Math.min(1, maxWidthPx / Math.max(1, widthPx), maxHeightPx / Math.max(1, heightPx));
	const columns = Math.max(1, Math.ceil((widthPx * scale) / cell.widthPx));
	const rows = Math.max(1, Math.ceil((heightPx * scale) / cell.heightPx));
	return { columns, rows };
}
