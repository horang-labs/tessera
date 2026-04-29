import type { ContentBlock } from '../ws/message-types';
import logger from '../logger';
import type { ProcessInfo } from './types';

export type QueuedInput = string | ContentBlock[];

export function enqueueProcessInput(
  stdinQueue: Map<string, QueuedInput[]>,
  sessionId: string,
  content: QueuedInput,
  maxQueueSize: number,
): number {
  const queue = stdinQueue.get(sessionId) ?? [];

  if (queue.length >= maxQueueSize) {
    logger.error({
      sessionId,
      queueSize: queue.length,
      maxSize: maxQueueSize,
    }, 'stdin queue full');
    throw new Error('Message queue is full. Please wait for previous messages to be processed.');
  }

  queue.push(content);
  stdinQueue.set(sessionId, queue);
  return queue.length;
}

export function writeQueuedProviderInput(
  stdinQueue: Map<string, QueuedInput[]>,
  sessionId: string,
  info: ProcessInfo,
  content: QueuedInput,
): boolean {
  const contentType = typeof content === 'string' ? 'string' : 'ContentBlock[]';

  logger.debug({
    sessionId,
    contentType,
    queueLen: stdinQueue.get(sessionId)?.length ?? 0,
    provider: info.provider.getDisplayName(),
  }, 'flushStdinQueue: writing to stdin via provider');

  const startTime = Date.now();

  try {
    const ok = info.provider.sendMessage(info.process, content);
    logger.debug({
      sessionId,
      duration: Date.now() - startTime,
      contentType,
      backpressure: !ok,
    }, 'provider.sendMessage completed');
    return ok;
  } catch (error) {
    logger.error({
      sessionId,
      error: (error as Error).message,
      contentType,
    }, 'provider.sendMessage failed');
    return true;
  }
}

export function scheduleNextProcessStdinFlush(
  stdinQueue: Map<string, QueuedInput[]>,
  sessionId: string,
  info: ProcessInfo,
  wroteWithoutBackpressure: boolean,
  flushQueue: () => void,
): void {
  const queue = stdinQueue.get(sessionId);
  if (!queue || queue.length === 0) {
    return;
  }

  if (!wroteWithoutBackpressure && info.process.stdin) {
    logger.warn({ sessionId }, 'flushStdinQueue: backpressure detected, waiting for drain');
    info.process.stdin.once('drain', () => {
      logger.debug({ sessionId }, 'flushStdinQueue: drain received, resuming queue');
      flushQueue();
    });
    return;
  }

  flushQueue();
}

export function writeJsonPayloadToProcessStdin(
  info: ProcessInfo | undefined,
  sessionId: string,
  payload: Record<string, any>,
  logContext: string,
): boolean {
  if (!info) {
    logger.warn({ sessionId }, `${logContext} failed: process not found`);
    return false;
  }

  if (!info.process.stdin?.writable) {
    logger.warn({ sessionId }, `${logContext} failed: stdin not writable`);
    return false;
  }

  info.lastActivityAt = new Date();
  const serialized = JSON.stringify(payload);
  const success = info.process.stdin.write(`${serialized}\n`, (error) => {
    if (error) {
      logger.error({ sessionId, error }, `${logContext} write failed`);
    } else {
      logger.debug({ sessionId }, `${logContext} sent`);
    }
  });

  if (!success) {
    logger.warn({ sessionId }, `${logContext}: stdin backpressure detected, waiting for drain`);

    const drainTimeout = setTimeout(() => {
      logger.error({ sessionId }, `${logContext}: stdin drain timeout (30s)`);
    }, 30000);

    info.process.stdin.once('drain', () => {
      clearTimeout(drainTimeout);
      logger.info({ sessionId }, `${logContext}: stdin buffer drained`);
    });
  }

  return true;
}
