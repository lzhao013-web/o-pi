declare module "@earendil-works/pi-coding-agent" {
	export interface ToolInfo {
		name: string;
		sourceInfo?: { source?: string };
	}

	export interface ExtensionContext {
		cwd: string;
	}

	export interface ToolResult {
		content: Array<{ type: "text"; text: string }>;
		details?: unknown;
	}

	export interface ToolDefinition<TParams = unknown> {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: unknown;
		execute(
			toolCallId: string,
			params: TParams,
			signal: AbortSignal,
			onUpdate: ((result: ToolResult) => void) | undefined,
			ctx: ExtensionContext,
		): Promise<ToolResult>;
	}

	export interface ExtensionAPI {
		registerTool<TParams>(definition: ToolDefinition<TParams>): void;
		on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void): void;
		getAllTools(): ToolInfo[];
		getActiveTools(): string[];
		setActiveTools(names: string[]): void;
	}
}
