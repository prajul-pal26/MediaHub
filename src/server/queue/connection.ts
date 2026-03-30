import Redis from "ioredis";

let _connection: Redis | null = null;

export function getQueueConnection(): Redis {
  if (!_connection) {
    _connection = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
    });
  }
  return _connection;
}
