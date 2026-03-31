import { Queue } from "bullmq";
import { getQueueConnection } from "./connection";

let _publishQueue: Queue | null = null;
let _analyticsQueue: Queue | null = null;
let _historicalImportQueue: Queue | null = null;
let _commentSyncQueue: Queue | null = null;

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
    });
  }
  return _historicalImportQueue;
}

export function getCommentSyncQueue(): Queue {
  if (!_commentSyncQueue) {
    _commentSyncQueue = new Queue("comment-sync", {
      connection: getQueueConnection(),
    });
  }
  return _commentSyncQueue;
}
