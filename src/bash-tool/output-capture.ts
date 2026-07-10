import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { CapturedOutput } from "./types.js";

interface CaptureOptions {
	sessionId: string;
	toolCallId: string;
	maxCaptureBytes: number;
	previewBytes: number;
}

/** 从第一字节开始落盘，同时只保留固定大小的 UTF-8 预览窗口。 */
export class OutputCapture {
	private readonly decoder = new StringDecoder("utf8");
	private readonly logPath: string;
	private readonly stream: WriteStream;
	private readonly previewLimit: number;
	private totalBytes = 0;
	private capturedBytes = 0;
	private lineBreaks = 0;
	private lastCharWasNewline = false;
	private head = "";
	private tail = "";
	private binary = false;
	private closed = false;

	private constructor(logPath: string, stream: WriteStream, private readonly maxCaptureBytes: number, previewBytes: number) {
		this.logPath = logPath;
		this.stream = stream;
		this.previewLimit = Math.max(1024, previewBytes);
	}

	static async create(options: CaptureOptions): Promise<OutputCapture> {
		const dir = path.join(os.tmpdir(), "o-pi", "bash", sanitizePathPart(options.sessionId));
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmodBestEffort(dir, 0o700);
		const logPath = path.join(dir, `${sanitizePathPart(options.toolCallId)}.log`);
		const stream = createWriteStream(logPath, { flags: "w", mode: 0o600 });
		await chmodBestEffort(logPath, 0o600);
		return new OutputCapture(logPath, stream, options.maxCaptureBytes, options.previewBytes);
	}

	append(data: Buffer): void {
		if (this.closed) return;
		this.totalBytes += data.byteLength;
		if (data.includes(0)) this.binary = true;

		if (this.capturedBytes < this.maxCaptureBytes) {
			const remaining = this.maxCaptureBytes - this.capturedBytes;
			const chunk = data.byteLength <= remaining ? data : data.subarray(0, remaining);
			this.stream.write(chunk);
			this.capturedBytes += chunk.byteLength;
		}

		this.appendPreview(this.decoder.write(data));
	}

	liveText(maxBytes: number): string {
		return takeTailBytes(this.tail || this.head, maxBytes);
	}

	async finish(): Promise<CapturedOutput> {
		if (this.closed) throw new Error("OutputCapture already closed.");
		this.closed = true;
		this.appendPreview(this.decoder.end());
		await new Promise<void>((resolve, reject) => {
			this.stream.end(() => resolve());
			this.stream.on("error", reject);
		});
		return {
			previewText: this.head + (this.tail && this.head !== this.tail ? this.tail : ""),
			totalBytes: this.totalBytes,
			totalLines: this.totalBytes === 0 ? 0 : this.lineBreaks + (this.lastCharWasNewline ? 0 : 1),
			logPath: this.logPath,
			captureComplete: this.capturedBytes === this.totalBytes,
			binary: this.binary,
		};
	}

	async deleteLog(): Promise<void> {
		await rm(this.logPath, { force: true });
	}

	private appendPreview(text: string): void {
		if (text.length === 0) return;
		for (const char of text) {
			if (char === "\n") this.lineBreaks += 1;
			this.lastCharWasNewline = char === "\n";
		}

		const headLimit = Math.floor(this.previewLimit / 2);
		if (Buffer.byteLength(this.head, "utf8") < headLimit) {
			this.head = takeHeadBytes(this.head + text, headLimit);
		}
		this.tail = takeTailBytes(this.tail + text, this.previewLimit - headLimit);
	}
}

export function sanitizePathPart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized.length > 0 ? sanitized.slice(0, 96) : "unknown";
}

export function takeHeadBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let result = "";
	let used = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (used + size > maxBytes) break;
		result += char;
		used += size;
	}
	return result;
}

export function takeTailBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const chars = Array.from(text);
	let result = "";
	let used = 0;
	for (let index = chars.length - 1; index >= 0; index -= 1) {
		const char = chars[index];
		if (char === undefined) break;
		const size = Buffer.byteLength(char, "utf8");
		if (used + size > maxBytes) break;
		result = char + result;
		used += size;
	}
	return result;
}

async function chmodBestEffort(target: string, mode: number): Promise<void> {
	try {
		await chmod(target, mode);
	} catch {
		// Windows 文件权限不完全兼容 POSIX mode；尽力设置即可。
	}
}
