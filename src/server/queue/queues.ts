import { Queue } from "bullmq";
import { getQueueConnection } from "./connection";

let _publishQueue: Queue | null = null;
let _analyticsQueue: Queue | null = null;
let _historicalImportQueue: Queue | null = null;
let _commentSyncQueue: Queue | null = null;

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
