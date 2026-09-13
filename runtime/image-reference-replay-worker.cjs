'use strict';
const { parentPort } = require('node:worker_threads');
const { ReplaySession } = require('./image-reference-replay.cjs');
let session;
let sessionId;
let work = Promise.resolve();
parentPort.on('message', message => {
  work = work.then(async () => {
  try {
    if (sessionId !== message.sessionId) { session = new ReplaySession(); sessionId = message.sessionId; }
    await session.read(message.path, message.offset, message.reset);
    const result = await session.run();
    parentPort.postMessage({ id: message.id, result });
  } catch (error) {
    session = undefined; sessionId = undefined;
    parentPort.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'Replay failed' });
  }
  });
});
