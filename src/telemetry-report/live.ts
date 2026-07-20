import type { TelemetryCollector, TelemetryCollectorSnapshot } from "../telemetry/collector.js";
import { calculateTelemetryReport } from "./statistics.js";
import type { ReportSnapshot } from "./types.js";

export interface LiveTelemetryReport {
	report: ReportSnapshot;
	sessionId?: string;
}

/** Revision cache keeps repeated /telemetry views cheap while refreshing volatile writer health. */
export class LiveTelemetryReporter {
	#revision = -1;
	#healthSignature = "";
	#cached: ReportSnapshot | undefined;

	create(collector: Pick<TelemetryCollector, "snapshot">, generatedAt = new Date().toISOString()): LiveTelemetryReport {
		const snapshot = collector.snapshot();
		const healthSignature = snapshotHealthSignature(snapshot);
		if (this.#cached === undefined || snapshot.revision !== this.#revision || healthSignature !== this.#healthSignature) {
			this.#cached = calculateLiveReport(snapshot, generatedAt);
			this.#revision = snapshot.revision;
			this.#healthSignature = healthSignature;
		} else {
			this.#cached = {
				...this.#cached,
				metadata: liveMetadata(this.#cached, snapshot, generatedAt),
			};
		}
		return {
			report: this.#cached,
			...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
		};
	}
}

function snapshotHealthSignature(snapshot: TelemetryCollectorSnapshot): string {
	return JSON.stringify({ invalidLines: snapshot.invalidLines, omittedRecords: snapshot.omittedRecords,
		inProgressCalls: snapshot.inProgressCalls, writer: snapshot.writer });
}

export function calculateLiveReport(snapshot: TelemetryCollectorSnapshot, generatedAt = new Date().toISOString()): ReportSnapshot {
	return calculateTelemetryReport(snapshot.records, {
		generatedAt,
		scope: "current_session",
		consistency: "live_observed",
		invalidLines: snapshot.invalidLines,
		...(snapshot.lastCompletedTurn === undefined ? {} : { lastCompletedTurn: snapshot.lastCompletedTurn }),
		inProgressCalls: snapshot.inProgressCalls,
		pendingWrites: snapshot.writer.pending,
		failedWrites: snapshot.writer.failed,
		droppedWrites: snapshot.writer.dropped,
		omittedLiveRecords: snapshot.omittedRecords,
		...(snapshot.writer.last_failure_at === undefined ? {} : { lastWriteFailureAt: snapshot.writer.last_failure_at }),
	});
}

function liveMetadata(report: ReportSnapshot, snapshot: TelemetryCollectorSnapshot, generatedAt: string): ReportSnapshot["metadata"] {
	return {
		...report.metadata,
		generated_at: generatedAt,
		...(snapshot.lastCompletedTurn === undefined ? {} : { last_completed_turn: snapshot.lastCompletedTurn }),
		in_progress_calls: snapshot.inProgressCalls,
		pending_writes: snapshot.writer.pending,
		failed_writes: snapshot.writer.failed,
		dropped_writes: snapshot.writer.dropped,
		omitted_live_records: snapshot.omittedRecords,
		...(snapshot.writer.last_failure_at === undefined ? {} : { last_write_failure_at: snapshot.writer.last_failure_at }),
	};
}
