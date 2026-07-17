import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { languageFromPath } from "../code-index/parser.js";
import { throwIfAborted } from "./errors.js";
import { compareRepoMapEdge } from "./graph-types.js";
import type {
	RepoMapArchitectureNode,
	RepoMapComponentNode,
	RepoMapDiagnostic,
	RepoMapEdge,
	RepoMapEntrypointNode,
	RepoMapEntrypointType,
	RepoMapEvidence,
	RepoMapFileRecord,
	RepoMapPackageNode,
	RepoMapSymbolNode,
} from "./types.js";

export interface BuildRepoMapArchitectureInput {
	root: string;
	mapId: string;
	files: readonly RepoMapFileRecord[];
	symbols: readonly RepoMapSymbolNode[];
	signal?: AbortSignal;
	readText?: (absolutePath: string, signal?: AbortSignal) => Promise<string>;
}

export interface RepoMapArchitectureIndex {
	nodes: RepoMapArchitectureNode[];
	edges: RepoMapEdge[];
	symbols: RepoMapSymbolNode[];
	diagnostics: RepoMapDiagnostic[];
}

interface SourceFile {
	file: RepoMapFileRecord;
	text: string;
}

interface PackageDraft {
	node: RepoMapPackageNode;
	evidence: RepoMapEvidence;
	manifest?: SourceFile;
}

interface ManifestEntrypoint {
	name: string;
	type: RepoMapEntrypointType;
	target: string;
	script: boolean;
}

const MANIFEST_NAMES = new Set(["package.json", "pyproject.toml", "go.mod", "Cargo.toml"]);
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];

/** Build deterministic package/component/entrypoint facts without executing repository code. */
export async function buildRepoMapArchitecture(input: BuildRepoMapArchitectureInput): Promise<RepoMapArchitectureIndex> {
	throwIfAborted(input.signal);
	const readText = input.readText ?? defaultReadText;
	const filesByPath = new Map(input.files.map((file) => [file.path, file]));
	const sourceFiles = new Map<string, SourceFile>();
	const diagnostics: RepoMapDiagnostic[] = [];
	const shouldRead = (file: RepoMapFileRecord): boolean => file.status === "indexed"
		&& (MANIFEST_NAMES.has(path.posix.basename(file.path)) || isScriptFile(file.path));
	for (const file of input.files) {
		if (!shouldRead(file)) continue;
		throwIfAborted(input.signal);
		try {
			const text = await readText(path.join(input.root, file.path), input.signal);
			if (file.contentHash === undefined || hash(text) !== file.contentHash) {
				diagnostics.push({ code: "ARCHITECTURE_FILE_CHANGED", message: "File changed while architecture facts were indexed.", path: file.path });
				continue;
			}
			sourceFiles.set(file.path, { file, text });
		} catch {
			diagnostics.push({ code: "ARCHITECTURE_FILE_UNREADABLE", message: "File could not be read while architecture facts were indexed.", path: file.path });
		}
	}

	const packages = discoverPackages(input.root, input.files, sourceFiles, diagnostics);
	const packageForFile = new Map<string, PackageDraft>();
	for (const file of input.files) {
		const owner = deepestPackage(packages, file.path);
		if (owner !== undefined) packageForFile.set(file.id, owner);
	}
	const components = discoverComponents(input.files, packageForFile);
	const componentForFile = new Map<string, RepoMapComponentNode>();
	for (const file of input.files) {
		const owner = packageForFile.get(file.id);
		if (owner === undefined) continue;
		const component = componentFor(owner.node, file.path, components);
		if (component !== undefined) componentForFile.set(file.id, component);
	}

	const nodes: RepoMapArchitectureNode[] = [...packages.map((item) => item.node), ...components];
	const edges: RepoMapEdge[] = [];
	const repositoryId = `repository:${input.mapId}`;
	for (const item of packages) edges.push(edge(repositoryId, item.node.id, "contains", "manifest", item.node.confidence, item.evidence));
	for (const component of components) {
		const evidence = componentEvidence(component, input.files, componentForFile);
		if (evidence !== undefined) edges.push(edge(component.packageId, component.id, "contains", "convention", component.confidence, evidence));
	}
	for (const file of input.files) {
		const owner = packageForFile.get(file.id);
		const component = componentForFile.get(file.id);
		const evidence = fileEvidence(file);
		if (owner !== undefined) edges.push(edge(file.id, owner.node.id, "belongs-to", owner.node.source === "manifest" ? "manifest" : "convention", owner.node.confidence, evidence));
		if (component !== undefined) edges.push(edge(file.id, component.id, "belongs-to", "convention", component.confidence, evidence));
	}
	for (const symbol of input.symbols) {
		const file = input.files.find((candidate) => candidate.id === symbol.fileId);
		if (file === undefined) continue;
		const owner = packageForFile.get(file.id);
		const component = componentForFile.get(file.id);
		const evidence = symbolEvidence(file, symbol);
		if (owner !== undefined) edges.push(edge(symbol.id, owner.node.id, "belongs-to", owner.node.source === "manifest" ? "manifest" : "convention", owner.node.confidence, evidence));
		if (component !== undefined) edges.push(edge(symbol.id, component.id, "belongs-to", "convention", component.confidence, evidence));
	}

	const publicFiles = new Set<string>();
	for (const item of packages) {
		for (const declaration of manifestEntrypoints(item, diagnostics)) {
			const resolved = resolveDeclaredTarget(item.node.rootPath, declaration.target, filesByPath);
			const evidence = item.manifest === undefined ? item.evidence : evidenceForText(item.manifest, declaration.target);
			const entrypoint = makeEntrypoint(item.node, declaration, resolved?.id);
			nodes.push(entrypoint);
			edges.push(edge(item.node.id, entrypoint.id, declaration.script ? "declares-script" : "declares-entrypoint", "manifest", 1, evidence, declaration.target));
			if (resolved !== undefined) {
				edges.push(edge(entrypoint.id, resolved.id, "contains", "manifest", 0.98, evidence, declaration.target));
				if (declaration.type === "main" || declaration.type === "module" || declaration.type === "export" || declaration.type === "bin") {
					publicFiles.add(resolved.id);
					edges.push(edge(item.node.id, resolved.id, "exports-publicly", "manifest", 0.98, evidence, declaration.target));
				}
			}
		}
	}

	const reExportedSymbols = new Set<string>();
	for (const source of sourceFiles.values()) {
		if (!isJavaScriptFamily(source.file.path)) continue;
		const owner = packageForFile.get(source.file.id);
		const component = componentForFile.get(source.file.id);
		for (const fact of registrationFacts(source.text)) {
			const entrypoint = registrationEntrypoint(fact, source.file, owner?.node);
			nodes.push(entrypoint);
			edges.push(edge(source.file.id, entrypoint.id, fact.edgeKind, "syntax", fact.confidence, evidenceForRange(source, fact.start, fact.end), fact.lexicalTarget));
			if (component !== undefined) edges.push(edge(entrypoint.id, component.id, "belongs-to", "convention", component.confidence, evidenceForRange(source, fact.start, fact.end)));
		}
		if (isExtensionConvention(source.file.path, source.text)) {
			const entrypoint = conventionPluginEntrypoint(source.file, owner?.node);
			nodes.push(entrypoint);
			edges.push(edge(source.file.id, entrypoint.id, "registers-plugin", "convention", 0.72, evidenceForMatch(source, /\bexport\s+default\b/u)));
		}
		for (const fact of reExportFacts(source.text)) {
			const target = resolveDeclaredTarget(path.posix.dirname(source.file.path), fact.target, filesByPath);
			const evidence = evidenceForRange(source, fact.start, fact.end);
			if (target === undefined) {
				edges.push(edge(source.file.id, `external:${encodeURIComponent(fact.target)}`, "re-exports", "syntax", 0.45, evidence, fact.target));
				continue;
			}
			edges.push(edge(source.file.id, target.id, "re-exports", "syntax", 0.94, evidence, fact.target));
			const targetSymbols = input.symbols.filter((symbol) => symbol.fileId === target.id && isRequestedExport(symbol, fact.names));
			for (const symbol of targetSymbols) {
				reExportedSymbols.add(symbol.id);
				edges.push(edge(source.file.id, symbol.id, "exports-publicly", "syntax", 0.92, evidence, symbol.name));
			}
			if (publicFiles.has(source.file.id)) publicFiles.add(target.id);
		}
		for (const match of source.text.matchAll(/\bexport\s+default\b/gu)) {
			if (match.index === undefined) continue;
			const entrypoint: RepoMapEntrypointNode = {
				kind: "entrypoint",
				id: architectureId("entrypoint", source.file.id, "export", "default"),
				name: "default",
				entrypointType: "export",
				...(owner !== undefined ? { packageId: owner.node.id } : {}),
				fileId: source.file.id,
				source: "syntactic",
				confidence: 0.96,
			};
			nodes.push(entrypoint);
			edges.push(edge(source.file.id, entrypoint.id, "exports-publicly", "syntax", 0.96, evidenceForRange(source, match.index, match.index + match[0].length)));
		}
	}

	const symbols = input.symbols.map((symbol) => {
		const publicSymbol = isModulePublic(symbol, input.files)
			|| reExportedSymbols.has(symbol.id);
		return { ...symbol, visibility: publicSymbol ? "public" as const : "internal" as const };
	});
	for (const symbol of symbols) {
		if (symbol.visibility !== "public") continue;
		const owner = packageForFile.get(symbol.fileId);
		const file = input.files.find((candidate) => candidate.id === symbol.fileId);
		if (owner !== undefined && file !== undefined) edges.push(edge(
			owner.node.id,
			symbol.id,
			"exports-publicly",
			owner.node.source === "manifest" ? "manifest" : "convention",
			publicFiles.has(symbol.fileId) ? 0.96 : owner.node.source === "manifest" ? 0.78 : 0.68,
			symbolEvidence(file, symbol),
		));
	}

	return {
		nodes: uniqueNodes(nodes),
		edges: coalesceEdges(edges),
		symbols,
		diagnostics,
	};
}

function discoverPackages(
	root: string,
	files: readonly RepoMapFileRecord[],
	sources: ReadonlyMap<string, SourceFile>,
	diagnostics: RepoMapDiagnostic[],
): PackageDraft[] {
	const result: PackageDraft[] = [];
	for (const source of sources.values()) {
		const manifestName = path.posix.basename(source.file.path);
		if (!MANIFEST_NAMES.has(manifestName)) continue;
		const packageRoot = path.posix.dirname(source.file.path) === "." ? "." : path.posix.dirname(source.file.path);
		const parsed = manifestPackage(manifestName, source.text, packageRoot, root);
		if (parsed === undefined) {
			diagnostics.push({ code: "ARCHITECTURE_MANIFEST_INVALID", message: "Manifest could not be parsed for package metadata.", path: source.file.path });
			continue;
		}
		const node: RepoMapPackageNode = {
			kind: "package",
			id: architectureId("package", parsed.ecosystem, packageRoot, parsed.name),
			name: parsed.name,
			rootPath: packageRoot,
			ecosystem: parsed.ecosystem,
			manifestPath: source.file.path,
			source: "manifest",
			confidence: 1,
		};
		result.push({ node, evidence: fileEvidence(source.file), manifest: source });
	}
	if (result.length === 0) {
		const first = files[0];
		if (first !== undefined) {
			const name = path.basename(root);
			result.push({
				node: { kind: "package", id: architectureId("package", "repository", ".", name), name, rootPath: ".", ecosystem: "repository", source: "convention", confidence: 0.65 },
				evidence: fileEvidence(first),
			});
		}
	}
	return result.sort((left, right) => right.node.rootPath.length - left.node.rootPath.length || compare(left.node.id, right.node.id));
}

function manifestPackage(
	manifestName: string,
	text: string,
	packageRoot: string,
	repositoryRoot: string,
): { name: string; ecosystem: RepoMapPackageNode["ecosystem"] } | undefined {
	if (manifestName === "package.json") {
		try {
			const value = JSON.parse(text) as unknown;
			if (!isRecord(value)) return undefined;
			const name = typeof value["name"] === "string" && value["name"].length > 0 ? value["name"] : fallbackPackageName(packageRoot, repositoryRoot);
			return { name, ecosystem: "npm" };
		} catch { return undefined; }
	}
	if (manifestName === "pyproject.toml") return { name: capture(text, /^\s*name\s*=\s*["']([^"']+)["']/mu) ?? fallbackPackageName(packageRoot, repositoryRoot), ecosystem: "python" };
	if (manifestName === "go.mod") return { name: capture(text, /^\s*module\s+(\S+)/mu) ?? fallbackPackageName(packageRoot, repositoryRoot), ecosystem: "go" };
	if (manifestName === "Cargo.toml") return { name: capture(text, /^\s*name\s*=\s*["']([^"']+)["']/mu) ?? fallbackPackageName(packageRoot, repositoryRoot), ecosystem: "cargo" };
	return undefined;
}

function manifestEntrypoints(item: PackageDraft, diagnostics: RepoMapDiagnostic[]): ManifestEntrypoint[] {
	const source = item.manifest;
	if (source === undefined) return [];
	const name = path.posix.basename(source.file.path);
	if (name === "package.json") {
		try {
			const value = JSON.parse(source.text) as unknown;
			if (!isRecord(value)) return [];
			const result: ManifestEntrypoint[] = [];
			for (const type of ["main", "module"] as const) if (typeof value[type] === "string") result.push({ name: type, type, target: value[type], script: false });
			const bin = value["bin"];
			if (typeof bin === "string") result.push({ name: item.node.name, type: "bin", target: bin, script: false });
			else if (isRecord(bin)) for (const [key, target] of Object.entries(bin)) if (typeof target === "string") result.push({ name: key, type: "bin", target, script: false });
			for (const exported of flattenExports(value["exports"])) result.push({ name: exported.name, type: "export", target: exported.target, script: false });
			const scripts = value["scripts"];
			if (isRecord(scripts)) for (const [key, target] of Object.entries(scripts)) if (typeof target === "string") result.push({ name: key, type: /^test(?::|$)/u.test(key) ? "test" : "script", target, script: true });
			return result;
		} catch {
			diagnostics.push({ code: "ARCHITECTURE_MANIFEST_INVALID", message: "package.json entrypoints could not be parsed.", path: source.file.path });
			return [];
		}
	}
	if (name === "pyproject.toml") {
		const section = /\[project\.scripts\]\s*\n(?<body>[\s\S]*?)(?=\n\s*\[|$)/u.exec(source.text)?.groups?.["body"] ?? "";
		return [...section.matchAll(/^\s*([\w.-]+)\s*=\s*["']([^"']+)["']/gmu)]
			.flatMap((match) => match[1] !== undefined && match[2] !== undefined
				? [{ name: match[1], type: "bin" as const, target: match[2], script: false }] : []);
	}
	return [];
}

function flattenExports(value: unknown, key = "."): Array<{ name: string; target: string }> {
	if (typeof value === "string") return [{ name: key, target: value }];
	if (!isRecord(value)) return [];
	const result: Array<{ name: string; target: string }> = [];
	for (const [childKey, child] of Object.entries(value)) result.push(...flattenExports(child, childKey.startsWith(".") ? childKey : key));
	return result;
}

function discoverComponents(
	files: readonly RepoMapFileRecord[],
	owners: ReadonlyMap<string, PackageDraft>,
): RepoMapComponentNode[] {
	const result = new Map<string, RepoMapComponentNode>();
	for (const file of files) {
		const owner = owners.get(file.id);
		if (owner === undefined) continue;
		const relative = relativeToPackage(owner.node.rootPath, file.path);
		const segment = relative.includes("/") ? relative.slice(0, relative.indexOf("/")) : "root";
		const rootPath = segment === "root" ? owner.node.rootPath : joinRepoPath(owner.node.rootPath, segment);
		const id = architectureId("component", owner.node.id, segment);
		result.set(id, { kind: "component", id, name: segment, rootPath, packageId: owner.node.id, source: "convention", confidence: segment === "root" ? 0.78 : 0.88 });
	}
	return [...result.values()].sort((left, right) => compare(left.id, right.id));
}

function deepestPackage(packages: readonly PackageDraft[], filePath: string): PackageDraft | undefined {
	return packages.find((item) => item.node.rootPath === "." || filePath === item.node.rootPath || filePath.startsWith(`${item.node.rootPath}/`));
}

function componentFor(owner: RepoMapPackageNode, filePath: string, components: readonly RepoMapComponentNode[]): RepoMapComponentNode | undefined {
	const relative = relativeToPackage(owner.rootPath, filePath);
	const segment = relative.includes("/") ? relative.slice(0, relative.indexOf("/")) : "root";
	return components.find((component) => component.packageId === owner.id && component.name === segment);
}

function componentEvidence(component: RepoMapComponentNode, files: readonly RepoMapFileRecord[], owners: ReadonlyMap<string, RepoMapComponentNode>): RepoMapEvidence | undefined {
	const file = files.find((candidate) => owners.get(candidate.id)?.id === component.id);
	return file === undefined ? undefined : fileEvidence(file);
}

function makeEntrypoint(owner: RepoMapPackageNode, declaration: ManifestEntrypoint, fileId: string | undefined): RepoMapEntrypointNode {
	return {
		kind: "entrypoint",
		id: architectureId("entrypoint", owner.id, declaration.type, declaration.name, declaration.target),
		name: declaration.name,
		entrypointType: declaration.type,
		packageId: owner.id,
		...(fileId !== undefined ? { fileId } : {}),
		declaredTarget: declaration.target,
		source: "manifest",
		confidence: fileId === undefined ? 0.72 : 1,
	};
}

interface RegistrationFact {
	name: string;
	type: "command" | "tool" | "plugin";
	edgeKind: "registers-command" | "registers-tool" | "registers-plugin";
	start: number;
	end: number;
	confidence: number;
	lexicalTarget: string;
}

function registrationFacts(text: string): RegistrationFact[] {
	const constants = new Map<string, string>();
	for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([^"'`]+)["'`]/gu)) {
		if (match[1] !== undefined && match[2] !== undefined) constants.set(match[1], match[2]);
	}
	const result: RegistrationFact[] = [];
	for (const type of ["Command", "Tool", "Plugin", "Extension"] as const) {
		const pattern = new RegExp(`\\bregister${type}\\s*\\(`, "gu");
		for (const match of text.matchAll(pattern)) {
			if (match.index === undefined) continue;
			const snippet = text.slice(match.index, match.index + 900);
			const expression = type === "Tool"
				? capture(snippet, /\bname\s*:\s*(["'`][^"'`]+["'`]|[A-Za-z_$][\w$]*)/u)
				: capture(snippet, /^\w+\s*\(\s*(["'`][^"'`]+["'`]|[A-Za-z_$][\w$]*)/u);
			if (expression === undefined) continue;
			const literal = /^["'`]/u.test(expression) ? expression.slice(1, -1) : constants.get(expression);
			const normalizedType = type === "Extension" ? "plugin" : type.toLocaleLowerCase() as "command" | "tool" | "plugin";
			result.push({
				name: literal ?? expression,
				type: normalizedType,
				edgeKind: normalizedType === "command" ? "registers-command" : normalizedType === "tool" ? "registers-tool" : "registers-plugin",
				start: match.index,
				end: match.index + Math.min(snippet.length, Math.max(match[0].length, snippet.indexOf("\n") < 0 ? match[0].length : snippet.indexOf("\n"))),
				confidence: literal === undefined ? 0.62 : 0.96,
				lexicalTarget: expression,
			});
		}
	}
	return result;
}

function registrationEntrypoint(fact: RegistrationFact, file: RepoMapFileRecord, owner: RepoMapPackageNode | undefined): RepoMapEntrypointNode {
	return {
		kind: "entrypoint",
		id: architectureId("entrypoint", file.id, fact.type, fact.name),
		name: fact.name,
		entrypointType: fact.type,
		...(owner !== undefined ? { packageId: owner.id } : {}),
		fileId: file.id,
		declaredTarget: fact.lexicalTarget,
		source: "syntactic",
		confidence: fact.confidence,
	};
}

function conventionPluginEntrypoint(file: RepoMapFileRecord, owner: RepoMapPackageNode | undefined): RepoMapEntrypointNode {
	return {
		kind: "entrypoint",
		id: architectureId("entrypoint", file.id, "plugin", "default"),
		name: path.posix.basename(file.path, path.posix.extname(file.path)),
		entrypointType: "plugin",
		...(owner !== undefined ? { packageId: owner.id } : {}),
		fileId: file.id,
		declaredTarget: "default export",
		source: "convention",
		confidence: 0.72,
	};
}

interface ReExportFact { target: string; names: "*" | Set<string>; start: number; end: number }

function reExportFacts(text: string): ReExportFact[] {
	const result: ReExportFact[] = [];
	for (const match of text.matchAll(/\bexport\s+(?<body>\*|\{[^}]*\})\s+from\s+["'](?<target>[^"']+)["']/gu)) {
		if (match.index === undefined || match.groups?.["body"] === undefined || match.groups["target"] === undefined) continue;
		const body = match.groups["body"];
		const names = body === "*" ? "*" : new Set(body.slice(1, -1).split(",").map((item) => item.trim().split(/\s+as\s+/u)[0]).filter((item): item is string => item !== undefined && item.length > 0));
		result.push({ target: match.groups["target"], names, start: match.index, end: match.index + match[0].length });
	}
	return result;
}

function resolveDeclaredTarget(
	basePath: string,
	declaredTarget: string,
	files: ReadonlyMap<string, RepoMapFileRecord>,
): RepoMapFileRecord | undefined {
	let target = declaredTarget.trim();
	if (/^(?:node|tsx?|python\d*|bun)\s+/u.test(target)) target = target.replace(/^\S+\s+/u, "").split(/\s+/u)[0] ?? target;
	if (target.includes(":")) return undefined;
	const clean = target.replace(/^\.\//u, "").split(/[?#]/u)[0] ?? target;
	const joined = path.posix.normalize(basePath === "." ? clean : path.posix.join(basePath, clean));
	const candidates = [joined];
	const extension = path.posix.extname(joined);
	if (extension === "") for (const item of CODE_EXTENSIONS) candidates.push(`${joined}${item}`, `${joined}/index${item}`);
	else if ([".js", ".mjs", ".cjs"].includes(extension)) for (const item of [".ts", ".tsx", ".js", ".jsx"]) candidates.push(`${joined.slice(0, -extension.length)}${item}`);
	return candidates.flatMap((candidate) => files.get(candidate) ?? []).at(0);
}

function isRequestedExport(symbol: RepoMapSymbolNode, names: "*" | ReadonlySet<string>): boolean {
	return names === "*" || (symbol.name !== undefined && names.has(symbol.name));
}

function isModulePublic(symbol: RepoMapSymbolNode, files: readonly RepoMapFileRecord[]): boolean {
	const file = files.find((candidate) => candidate.id === symbol.fileId);
	if (file === undefined || symbol.name === undefined || symbol.qualifiedName !== symbol.name) return false;
	const language = languageFromPath(file.path);
	if (["typescript", "tsx", "javascript", "jsx"].includes(language)) return /^export\b/u.test(symbol.signature ?? "");
	if (language === "python") return !symbol.name.startsWith("_");
	if (language === "go") return /^\p{Lu}/u.test(symbol.name);
	if (language === "rust") return /^pub(?:\([^)]*\))?\s/u.test(symbol.signature ?? "");
	return false;
}

function isExtensionConvention(filePath: string, text: string): boolean {
	return /\bexport\s+default\b/u.test(text)
		&& (filePath.startsWith("agent/extensions/") || /(?:^|\/)(?:extensions?|plugins?)(?:\/|$)/u.test(filePath));
}

function isScriptFile(filePath: string): boolean {
	return isJavaScriptFamily(filePath) || /\.(?:py|go|rs)$/u.test(filePath);
}

function isJavaScriptFamily(filePath: string): boolean {
	return /\.(?:[cm]?js|jsx|tsx?)$/u.test(filePath);
}

function uniqueNodes(nodes: readonly RepoMapArchitectureNode[]): RepoMapArchitectureNode[] {
	const result = new Map<string, RepoMapArchitectureNode>();
	for (const node of nodes) {
		const current = result.get(node.id);
		if (current === undefined || node.confidence > current.confidence) result.set(node.id, node);
	}
	return [...result.values()].sort((left, right) => compare(left.kind, right.kind) || compare(left.id, right.id));
}

function coalesceEdges(edges: readonly RepoMapEdge[]): RepoMapEdge[] {
	const result = new Map<string, RepoMapEdge>();
	for (const item of edges) {
		const key = [item.kind, item.from, item.to, item.resolution, item.source, item.confidence, item.lexicalTarget ?? ""].join("\0");
		const current = result.get(key);
		if (current === undefined) result.set(key, { ...item, evidence: [...item.evidence] });
		else current.evidence.push(...item.evidence);
	}
	for (const item of result.values()) item.evidence = uniqueEvidence(item.evidence);
	return [...result.values()].sort(compareRepoMapEdge);
}

function edge(
	from: string,
	to: string,
	kind: RepoMapEdge["kind"],
	source: RepoMapEdge["source"],
	confidence: number,
	evidence: RepoMapEvidence,
	lexicalTarget?: string,
): RepoMapEdge {
	return { from, to, kind, resolution: source === "manifest" ? "syntactic" : source === "convention" ? "lexical" : "syntactic", source, confidence, ...(lexicalTarget !== undefined && lexicalTarget.length > 0 ? { lexicalTarget } : {}), evidence: [evidence] };
}

function uniqueEvidence(values: readonly RepoMapEvidence[]): RepoMapEvidence[] {
	const result = new Map<string, RepoMapEvidence>();
	for (const value of values) result.set(`${value.path}\0${value.startByte}\0${value.endByte}`, value);
	return [...result.values()].sort((left, right) => compare(left.path, right.path) || left.startByte - right.startByte);
}

function fileEvidence(file: RepoMapFileRecord): RepoMapEvidence {
	return { path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), startLine: 1, endLine: 1, startByte: 0, endByte: Math.min(file.size, 1) };
}

function symbolEvidence(file: RepoMapFileRecord, symbol: RepoMapSymbolNode): RepoMapEvidence {
	return { path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), startLine: symbol.startLine, endLine: symbol.endLine, startByte: symbol.startByte, endByte: symbol.endByte };
}

function evidenceForText(source: SourceFile, needle: string): RepoMapEvidence {
	const index = source.text.indexOf(needle);
	return evidenceForRange(source, Math.max(0, index), Math.max(0, index) + needle.length);
}

function evidenceForMatch(source: SourceFile, pattern: RegExp): RepoMapEvidence {
	const match = pattern.exec(source.text);
	return evidenceForRange(source, match?.index ?? 0, (match?.index ?? 0) + (match?.[0].length ?? 1));
}

function evidenceForRange(source: SourceFile, startChar: number, endChar: number): RepoMapEvidence {
	const prefix = source.text.slice(0, startChar);
	const selected = source.text.slice(startChar, endChar);
	const startByte = Buffer.byteLength(prefix);
	const endByte = startByte + Buffer.byteLength(selected);
	const startLine = prefix.split("\n").length;
	const endLine = startLine + selected.split("\n").length - 1;
	return { path: source.file.path, ...(source.file.contentHash !== undefined ? { textHash: source.file.contentHash } : {}), startLine, endLine, startByte, endByte };
}

function architectureId(kind: string, ...parts: string[]): string {
	const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
	return `${kind}:${digest}`;
}

function relativeToPackage(packageRoot: string, filePath: string): string {
	return packageRoot === "." ? filePath : path.posix.relative(packageRoot, filePath);
}

function joinRepoPath(left: string, right: string): string {
	return left === "." ? right : path.posix.join(left, right);
}

function fallbackPackageName(packageRoot: string, repositoryRoot: string): string {
	return packageRoot === "." ? path.basename(repositoryRoot) : path.posix.basename(packageRoot);
}

function capture(text: string, pattern: RegExp): string | undefined {
	return pattern.exec(text)?.[1];
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultReadText(absolutePath: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return await handle.readFile({ encoding: "utf8", ...(signal !== undefined ? { signal } : {}) });
	} finally {
		await handle.close();
	}
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
