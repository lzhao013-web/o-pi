import { createRequire } from "node:module";
import type ParserModule from "tree-sitter";

import type { CodeLanguage } from "./types.js";

type TreeSitterLanguage = ParserModule.Language;
type ParserConstructor = typeof ParserModule;

export interface TreeSitterRuntime {
	Parser: ParserConstructor;
	language: TreeSitterLanguage;
}

const require = createRequire(import.meta.url);
const runtimes = new Map<CodeLanguage, TreeSitterRuntime | undefined>();
let parserConstructor: ParserConstructor | undefined;
let javascriptGrammar: TreeSitterLanguage | undefined;
let typescriptGrammar: { typescript: TreeSitterLanguage; tsx: TreeSitterLanguage } | undefined;

/** runtime 与对应 grammar 仅在首次解析受支持语言时同步加载，并在进程内复用。 */
export function loadTreeSitterRuntime(language: CodeLanguage): TreeSitterRuntime | undefined {
	if (language === "text") return undefined;
	if (runtimes.has(language)) return runtimes.get(language);

	let runtime: TreeSitterRuntime | undefined;
	try {
		const Parser = parserConstructor ??= require("tree-sitter") as ParserConstructor;
		const grammar = loadGrammar(language);
		if (grammar !== undefined) runtime = { Parser, language: grammar };
	} catch {
		runtime = undefined;
	}
	runtimes.set(language, runtime);
	return runtime;
}

function loadGrammar(language: Exclude<CodeLanguage, "text">): TreeSitterLanguage | undefined {
	if (language === "javascript" || language === "jsx") {
		return javascriptGrammar ??= require("tree-sitter-javascript") as TreeSitterLanguage;
	}
	if (language === "typescript" || language === "tsx") {
		const grammar = typescriptGrammar ??= require("tree-sitter-typescript") as {
			typescript: TreeSitterLanguage;
			tsx: TreeSitterLanguage;
		};
		return language === "typescript" ? grammar.typescript : grammar.tsx;
	}
	if (language === "python") return require("tree-sitter-python") as TreeSitterLanguage;
	if (language === "go") return require("tree-sitter-go") as TreeSitterLanguage;
	return require("tree-sitter-rust") as TreeSitterLanguage;
}
