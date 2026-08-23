/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort.postMessage has no targetOrigin */
import { parentPort } from 'node:worker_threads';

import { Job } from './Job.js';

function ownDataValue(object, property) {
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function serializeError(error, seen = new WeakSet()) {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error) };
  }
  if (seen.has(error)) {
    return { name: 'Error', message: 'Circular error cause' };
  }
  seen.add(error);
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause === undefined ? undefined : serializeError(error.cause, seen),
  };
}

function validateExport(JobClass, metaUrl) {
  if (
    typeof JobClass !== 'function' ||
    !JobClass.prototype ||
    Object.getPrototypeOf(JobClass.prototype) !== Job.prototype ||
    ownDataValue(JobClass, 'metaUrl') !== metaUrl ||
    typeof ownDataValue(JobClass.prototype, 'run') !== 'function'
  ) {
    throw new TypeError('Job module default export does not match the declared contract');
  }
}

const controllers = new Map();

parentPort.on('message', async ({ type, id, metaUrl, payload }) => {
  if (type === 'cancel') {
    controllers.get(id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    const module = await import(metaUrl);
    validateExport(module.default, metaUrl);
    const result = await new module.default().run(payload, { signal: controller.signal });
    try {
      parentPort.postMessage({ id, status: 'success', result });
    } catch (error) {
      parentPort.postMessage({ id, status: 'clone-error', error: serializeError(error) });
    }
  } catch (error) {
    parentPort.postMessage({ id, status: 'error', error: serializeError(error) });
  } finally {
    controllers.delete(id);
  }
});
