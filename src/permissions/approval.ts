import type { AuthorizationRequest, CompiledDecision, PermissionPromptContext, UserPermissionDecision } from "./permission-types.js";

interface QueueItem {
	request: AuthorizationRequest;
	decision: CompiledDecision;
	context: PermissionPromptContext;
	resolve(result: ApprovalResult): void;
}

export type ApprovalResult =
	| { ok: true; decision: UserPermissionDecision }
	| { ok: false; reason: "timeout" | "cancelled" | "ui-error" };

/** 串行化审批 UI；相同输入 fingerprint 的并发请求共享一次审批。 */
export class ApprovalCoordinator {
	private readonly queue: QueueItem[] = [];
	private readonly pending = new Map<string, Promise<ApprovalResult>>();
	private running = false;
	private cancelled = false;

	request(request: AuthorizationRequest, decision: CompiledDecision, context: PermissionPromptContext): Promise<ApprovalResult> {
		if (this.cancelled || context.signal?.aborted) return Promise.resolve({ ok: false, reason: "cancelled" });
		const key = request.inputFingerprint;
		const existing = this.pending.get(key);
		if (existing !== undefined) return existing;
		const promise = new Promise<ApprovalResult>((resolve) => {
			this.queue.push({ request, decision, context, resolve });
			this.drain();
		});
		this.pending.set(key, promise);
		promise.finally(() => this.pending.delete(key)).catch(() => undefined);
		return promise;
	}

	cancelAll(): void {
		this.cancelled = true;
		for (const item of this.queue.splice(0)) item.resolve({ ok: false, reason: "cancelled" });
	}

	reset(): void {
		this.cancelled = false;
	}

	private async drain(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			for (;;) {
				const item = this.queue.shift();
				if (item === undefined) return;
				if (this.cancelled || item.context.signal?.aborted) {
					item.resolve({ ok: false, reason: "cancelled" });
					continue;
				}
				item.resolve(await this.askWithTimeout(item));
			}
		} finally {
			this.running = false;
		}
	}

	private async askWithTimeout(item: QueueItem): Promise<ApprovalResult> {
		let timeout: NodeJS.Timeout | undefined;
		try {
			const timeoutPromise = new Promise<ApprovalResult>((resolve) => {
				timeout = setTimeout(() => resolve({ ok: false, reason: "timeout" }), item.context.timeoutMs);
			});
			const promptPromise = item.context.prompt(item.request, item.decision).then((decision): ApprovalResult => ({ ok: true, decision }));
			return await Promise.race([timeoutPromise, promptPromise]);
		} catch {
			return { ok: false, reason: "ui-error" };
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
	}
}
