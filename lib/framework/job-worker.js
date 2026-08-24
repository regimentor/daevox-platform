/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort.postMessage has no targetOrigin */
import { parentPort } from 'node:worker_threads';

import { Job } from './Job.js';

/**

 * Reads an own data-property without invoking accessors. / Читает собственное data-свойство без вызова аксессоров.

 *

 * @param {Object} object Owner. / Владелец.

 * @param {PropertyKey} property Property key. / Ключ свойства.

 * @returns {*} Stored value or `undefined`. / Значение или `undefined`.

 * @private

 */
function ownDataValue(object, property) {
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**

 * Serializes an arbitrary thrown value and its error cause chain. / Сериализует произвольное выброшенное значение и цепочку причин ошибки.

 *

 * @param {*} error Thrown value. / Выброшенное значение.

 * @param {WeakSet<Error>} [seen] Visited errors. / Посещённые ошибки.

 * @returns {SerializedWorkerError} Transferable representation. / Передаваемое представление.

 * @private

 */
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

/**

 * Validates the default export loaded inside a worker. / Проверяет default export, загруженный внутри Worker.

 *

 * @param {Function} JobClass Loaded class. / Загруженный класс.

 * @param {string} metaUrl Requested module URL. / Запрошенный URL модуля.

 * @returns {void}

 * @private

 */
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

/**

 * Abort controllers for running jobs by task identifier. / Контроллеры отмены выполняемых задач по идентификатору.

 *

 * @type {Map<number, AbortController>}

 * @private

 */
const controllers = new Map();

/**

 * Handles parent-to-worker run and cancellation messages. / Обрабатывает сообщения запуска и отмены от родителя к Worker.

 *

 * @param {WorkerRunMessage|WorkerCancelMessage} message Worker protocol message. / Сообщение протокола Worker.

 * @returns {Promise<void>} Message completion. / Завершение обработки.

 * @private

 */
async function handleMessage(message) {
  const { type, id, metaUrl, payload } = message;
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
}

parentPort.on('message', handleMessage);
