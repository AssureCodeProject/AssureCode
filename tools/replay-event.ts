/**
 * tools/replay-event.ts — CLI tool to replay a dead-lettered event from a *.dlq stream back to the target stream.
 *
 * Usage:
 *   npx tsx tools/replay-event.ts REPLAY <dlq_stream> <message_id>
 *   npx tsx tools/replay-event.ts <dlq_stream> <message_id>
 */
import { Redis } from 'ioredis';
import { loadConfig } from '@assurecode/config';

export async function replayEvent(dlqStream: string, messageId: string, redisUrl?: string): Promise<{ success: boolean; targetTopic: string; newId: string }> {
  let url = redisUrl;
  if (!url) {
    try {
      const config = loadConfig();
      url = config.REDIS_URL;
    } catch {
      url = process.env.REDIS_URL || 'redis://localhost:6379';
    }
  }

  const redis = new Redis(url);

  try {
    const entries = (await redis.xrange(dlqStream, messageId, messageId)) as Array<[string, string[]]>;
    if (!entries || entries.length === 0) {
      throw new Error(`Message ${messageId} not found in stream ${dlqStream}`);
    }

    const [id, fields] = entries[0];
    const envIdx = fields.indexOf('envelope');
    if (envIdx === -1) {
      throw new Error(`Message ${id} in ${dlqStream} missing 'envelope' field`);
    }

    const envelopeStr = fields[envIdx + 1];
    const origStreamIdx = fields.indexOf('originalStream');
    const targetTopic =
      origStreamIdx !== -1
        ? fields[origStreamIdx + 1]
        : dlqStream.replace(/\.dlq$/, '');

    const newId = await redis.xadd(targetTopic, '*', 'envelope', envelopeStr);

    console.log(
      `[replay] Replayed event ${id} from ${dlqStream} -> ${targetTopic} (new ID: ${newId})`,
    );

    await redis.xdel(dlqStream, id);
    console.log(`[replay] Removed event ${id} from ${dlqStream}`);

    return { success: true, targetTopic, newId };
  } finally {
    await redis.quit();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let dlqStream = args[0];
  let messageId = args[1];

  if (dlqStream?.toUpperCase() === 'REPLAY') {
    dlqStream = args[1];
    messageId = args[2];
  }

  if (!dlqStream || !messageId) {
    console.error('Usage: npx tsx tools/replay-event.ts REPLAY <dlq_stream> <message_id>');
    process.exit(1);
  }

  try {
    await replayEvent(dlqStream, messageId);
  } catch (err) {
    console.error('[replay] Error replaying event:', err);
    process.exit(1);
  }
}

// Execute main if run directly
if (import.meta.url.startsWith('file:') && process.argv[1]?.includes('replay-event')) {
  main();
}
