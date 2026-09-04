#!/usr/bin/env node
/**
 * Synchronous WebWorker shim for running public/irt-worker.js under Node.
 *
 * The production worker uses `self.onmessage = ...` and `self.postMessage(...)`.
 * This helper installs a global.self shim, evals the worker source in the
 * current CommonJS scope, invokes the registered onmessage with {data: payload},
 * and routes every postMessage call to the supplied callback.
 *
 * Keep this file free of application logic: it is the shared skeleton that
 * replaces the hand-rolled eval-shim in the four IRT tool scripts.
 */
'use strict';
const fs = require('fs');

/**
 * @template T
 * @param {string} workerPath - absolute or relative path to the worker source
 * @param {Record<string, unknown>} payload - message payload (will be wrapped in {data: payload})
 * @param {(data: T) => void} [onMessage] - callback for EVERY postMessage from the worker
 * @param {string} [srcOverride] - optional worker source to eval instead of reading workerPath
 * @returns {{ getResult: () => T | null, getHandler: () => ((e: {data: Record<string, unknown>}) => void) | null }}
 */
function runWorkerSync(workerPath, payload, onMessage, srcOverride) {
  let workerOnMessage = null;
  let workerResult = null;

  const shim = {
    onmessage: null,
    postMessage(data) {
      if (data && data.type === 'result') {
        workerResult = data;
      }
      if (typeof onMessage === 'function') {
        onMessage(data);
      }
    },
  };

  Object.defineProperty(shim, 'onmessage', {
    set(fn) { workerOnMessage = fn; },
    get() { return workerOnMessage; },
  });

  // Make `self` resolve to shim inside the worker file.
  global.self = shim;

  const src = srcOverride ?? fs.readFileSync(workerPath, 'utf8');
  // eslint-disable-next-line no-eval
  eval(src);

  if (typeof workerOnMessage !== 'function') {
    throw new Error(`Worker at ${workerPath} did not register onmessage`);
  }

  workerOnMessage({ data: payload });

  return {
    getResult: () => workerResult,
    getHandler: () => workerOnMessage,
  };
}

module.exports = { runWorkerSync };
