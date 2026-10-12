import { Queue } from "bullmq";
import { getQueueConnection } from "./connection";

let _publishQueue: Queue | null = null;
let _analyticsQueue: Queue | null = null;
let _historicalImportQueue: Queue | null = null;
let _commentSyncQueue: Queue | null = null;
let _renderQueue: Queue | null = null;
let _audioImportQueue: Queue | null = null;

// Background discovery/sync jobs are operational work, not an audit log.  An
// unbounded completed-job set quietly grows Redis forever when accounts are
// reconnected.  Keep a small, recent diagnostic window instead.
const BACKGROUND_RETENTION = {
  removeOnComplete: { age: 24 * 60 * 60, count: 100 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 100 },
} as const;

export function getPublishQueue(): Queue {
  if (!_publishQueue) {
    _publishQueue = new Queue("publish", {
      connection: getQueueConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
  }
  return _publishQueue;
}

export function getAnalyticsQueue(): Queue {
  if (!_analyticsQueue) {
    _analyticsQueue = new Queue("analytics-fetch", {
      connection: getQueueConnection(),
    });
  }
  return _analyticsQueue;
}

export function getHistoricalImportQueue(): Queue {
  if (!_historicalImportQueue) {
    _historicalImportQueue = new Queue("historical-import", {
      connection: getQueueConnection(),
      defaultJobOptions: BACKGROUND_RETENTION,
    });
  }
  return _historicalImportQueue;
}

export function getCommentSyncQueue(): Queue {
  if (!_commentSyncQueue) {
    _commentSyncQueue = new Queue("comment-sync", {
      connection: getQueueConnection(),
      defaultJobOptions: BACKGROUND_RETENTION,
    });
  }
  return _commentSyncQueue;
}

// Editor renders.  The payload is deliberately ID-ONLY ({ editId }): Redis runs
// with --maxmemory 256mb --maxmemory-policy noeviction, so an edit document (or
// worse, a base64 overlay) in the job body would push the queue towards OOM and
// Redis would then start refusing writes rather than evicting.  The worker
// re-reads media_edits, which is also the only way a retry sees the latest doc.
//
// Only 2 attempts: a render failure is almost always a bad document or a Drive
// permission problem, neither of which a third try fixes, and each attempt
// re-downloads the original file.
export function getRenderQueue(): Queue {
  if (!_renderQueue) {
    _renderQueue = new Queue("render", {
      connection: getQueueConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30000 },
        ...BACKGROUND_RETENTION,
      },
    });
  }
  return _renderQueue;
}

/**
 * Extracting the audio from an Instagram reel into the brand's track library.
 *
 * A QUEUE OF ITS OWN rather than another job type on `render`, for three
 * reasons:
 *
 *  1. `renderWorker` runs with `concurrency: 1`. An import spends most of its
 *     time waiting on Instagram, and parking that wait in the render queue
 *     would leave the user's "Render" button looking stuck behind a download
 *     that has nothing to do with it (and vice versa — an import would queue
 *     behind a 400MB video encode).
 *  2. The two have genuinely different retry economics. A render failure is a
 *     bad document or a Drive permission problem; an import failure is usually
 *     Instagram refusing the request, which no number of retries fixes, so this
 *     one deliberately does not retry at all (see `attempts: 1`) and reports the
 *     real reason to the user instead of burning a shared session on retries.
 *  3. `renderWorker`'s handler is keyed on `job.data.editId` and immediately
 *     reads `media_edits`. A second payload shape would mean branching inside
 *     the render path, which is the one part of worker.ts that must not move.
 *
 * Payload is ID-ONLY (`{ trackId }`), for the same reason as `render`: Redis
 * runs with --maxmemory 256mb --maxmemory-policy noeviction, so it refuses
 * writes rather than evicting, and a URL plus metadata in every job body is
 * exactly the kind of slow growth that gets there. The worker re-reads
 * `audio_tracks` for the source URL.
 */
export function getAudioImportQueue(): Queue {
  if (!_audioImportQueue) {
    _audioImportQueue = new Queue("audio-import", {
      connection: getQueueConnection(),
      defaultJobOptions: {
        // One attempt. BullMQ would otherwise re-run a job whose row is already
        // 'failed' with a readable message, replace that message with the same
        // one 30s later, and hit Instagram twice for a link it already refused.
        attempts: 1,
        ...BACKGROUND_RETENTION,
      },
    });
  }
  return _audioImportQueue;
}
