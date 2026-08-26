import { MiddlewareExecutionError } from './errors.js';

/**
 * Shared immutable empty middleware list. / Общий неизменяемый пустой список middleware.
 *
 * @type {Function[]}
 * @private
 */
const EMPTY_MIDDLEWARE = Object.freeze([]);

/**
 * Validates and snapshots a dense middleware array.
 * Проверяет и копирует плотный массив middleware.
 *
 * @param {*} value Candidate middleware array or `undefined`. / Проверяемый массив middleware или
 * `undefined`.
 * @param {Function} createError Creates a transport-specific metadata error. / Создаёт
 * транспортно-специализированную ошибку метаданных.
 * @returns {Function[]} Frozen middleware snapshot. / Замороженный снимок middleware.
 * @private
 */
export function snapshotMiddleware(value, createError) {
  if (value === undefined) return EMPTY_MIDDLEWARE;
  if (!Array.isArray(value)) throw createError('middleware must be an array');

  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) =>
        typeof key === 'symbol' ? true : key !== 'length' && !/^(0|[1-9]\d*)$/.test(key),
      )
    ) {
      throw createError('middleware must be a dense array without additional fields');
    }

    const snapshot = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw createError('middleware entries must be functions');
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof Error && error.name !== 'TypeError') throw error;
    throw createError('middleware metadata is invalid');
  }
}

/**
 * Reads, validates, and snapshots an owner's own middleware declaration.
 * Читает, проверяет и копирует собственное объявление middleware владельца.
 *
 * @param {Object|Function} owner Middleware declaration owner. / Владелец объявления middleware.
 * @param {Function} createError Creates a transport-specific metadata error. / Создаёт
 * транспортно-специализированную ошибку метаданных.
 * @returns {Function[]} Frozen middleware snapshot. / Замороженный снимок middleware.
 * @private
 */
export function snapshotDeclaredMiddleware(owner, createError) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'middleware');
  if (!descriptor) return EMPTY_MIDDLEWARE;
  if (!('value' in descriptor) || descriptor.value === undefined) {
    throw createError('middleware must be an array when declared');
  }
  return snapshotMiddleware(descriptor.value, createError);
}

/**
 * Executable middleware chain. / Исполняемая цепочка middleware.
 *
 * @callback MiddlewareChainExecutor
 * @param {Object} ctx Transport operation context. / Контекст транспортной операции.
 * @returns {Promise<*>} Final chain result. / Итоговый результат цепочки.
 * @private
 */

/**
 * Middleware or terminal handler result. / Результат middleware или terminal handler.
 *
 * @callback MiddlewareTerminalHandler
 * @param {Object} ctx Transport operation context. / Контекст транспортной операции.
 * @returns {*|Promise<*>} Handler result. / Результат обработчика.
 * @private
 */

/**
 * Composes middleware around a terminal handler without transport normalization.
 * Композирует middleware вокруг terminal handler без транспортной нормализации.
 *
 * @param {Function[]} middleware Ordered middleware functions. / Упорядоченные функции middleware.
 * @param {MiddlewareTerminalHandler} terminalHandler Terminal handler. / Terminal handler.
 * @returns {MiddlewareChainExecutor} Executable chain. / Исполняемая цепочка.
 * @private
 */
export function composeMiddleware(middleware, terminalHandler) {
  /**
   * Executes the composed middleware chain for one transport context.
   * Выполняет скомпонованную цепочку middleware для одного транспортного контекста.
   *
   * @param {Object} ctx Transport operation context. / Контекст транспортной операции.
   * @returns {Promise<*>} Final chain result. / Итоговый результат цепочки.
   * @private
   */
  return async function executeMiddlewareChain(ctx) {
    /**
     * Dispatches one middleware or the terminal handler by chain index.
     * Вызывает одно middleware или terminal handler по индексу цепочки.
     *
     * @param {number} index Chain index. / Индекс цепочки.
     * @returns {Promise<*>} Result of the remaining chain. / Результат оставшейся цепочки.
     * @private
     */
    async function dispatch(index) {
      const current = middleware[index];
      if (current === undefined) return terminalHandler(ctx);

      let called = false;
      /**
       * Continues the current chain exactly once.
       * Однократно продолжает текущую цепочку.
       *
       * @returns {Promise<*>} Result of the remaining chain. / Результат оставшейся цепочки.
       * @throws {MiddlewareExecutionError} When called more than once. / При повторном вызове.
       * @private
       */
      const next = () => {
        if (called) {
          throw new MiddlewareExecutionError('middleware next() may only be called once');
        }
        called = true;
        return dispatch(index + 1);
      };
      return current(ctx, next);
    }

    return dispatch(0);
  };
}
