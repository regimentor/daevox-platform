import { MiddlewareExecutionError } from './errors.ts';

/** Generic middleware contract. / Обобщённый контракт middleware. @private */
export type Middleware<Context = object, Result = unknown> = (
  context: Context,
  next: () => Promise<Result>,
) => Result | Promise<Result>;

/** Transport-specific middleware error factory. / Фабрика ошибки middleware конкретного транспорта. @private */
type MiddlewareErrorFactory = (message: string) => Error;

/**
 * Shared immutable empty middleware list. / Общий неизменяемый пустой список middleware.
 * @private
 */
const EMPTY_MIDDLEWARE: readonly Middleware<any, any>[] = Object.freeze([]);

/**
 * Validates and snapshots a dense middleware array.
 * Проверяет и копирует плотный массив middleware.
 * @param value Candidate middleware array or `undefined`. / Проверяемый массив middleware или
 * `undefined`.
 * @param createError Creates a transport-specific metadata error. / Создаёт
 * транспортно-специализированную ошибку метаданных.
 * @returns Frozen middleware snapshot. / Замороженный снимок middleware.
 * @private
 */
export function snapshotMiddleware<Context = object, Result = unknown>(
  value: unknown,
  createError: MiddlewareErrorFactory,
): readonly Middleware<Context, Result>[] {
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

    const snapshot: Middleware<Context, Result>[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw createError('middleware entries must be functions');
      }
      snapshot.push(descriptor.value as Middleware<Context, Result>);
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
 * @param owner Middleware declaration owner. / Владелец объявления middleware.
 * @param createError Creates a transport-specific metadata error. / Создаёт
 * транспортно-специализированную ошибку метаданных.
 * @returns Frozen middleware snapshot. / Замороженный снимок middleware.
 * @private
 */
export function snapshotDeclaredMiddleware<Context = object, Result = unknown>(
  owner: object,
  createError: MiddlewareErrorFactory,
): readonly Middleware<Context, Result>[] {
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'middleware');
  if (!descriptor) return EMPTY_MIDDLEWARE;
  if (!('value' in descriptor) || descriptor.value === undefined) {
    throw createError('middleware must be an array when declared');
  }
  return snapshotMiddleware(descriptor.value, createError);
}

/**
 * Composes middleware around a terminal handler without transport normalization.
 * Композирует middleware вокруг terminal handler без транспортной нормализации.
 * @param middleware Ordered middleware functions. / Упорядоченные функции middleware.
 * @param terminalHandler Terminal handler. / Terminal handler.
 * @returns Executable chain. / Исполняемая цепочка.
 * @private
 */
export function composeMiddleware<Context, Result>(
  middleware: readonly Middleware<Context, Result>[],
  terminalHandler: (context: Context) => unknown,
): (context: Context) => Promise<Result> {
  /**
   * Executes the composed middleware chain for one transport context.
   * Выполняет скомпонованную цепочку middleware для одного транспортного контекста.
   * @param ctx Transport operation context. / Контекст транспортной операции.
   * @returns Final chain result. / Итоговый результат цепочки.
   * @private
   */
  return async function executeMiddlewareChain(ctx: Context): Promise<Result> {
    /**
     * Dispatches one middleware or the terminal handler by chain index.
     * Вызывает одно middleware или terminal handler по индексу цепочки.
     * @param index Chain index. / Индекс цепочки.
     * @returns Result of the remaining chain. / Результат оставшейся цепочки.
     * @private
     */
    async function dispatch(index: number): Promise<Result> {
      const current = middleware[index];
      if (current === undefined) return terminalHandler(ctx) as Result | Promise<Result>;

      let called = false;
      /**
       * Continues the current chain exactly once.
       * Однократно продолжает текущую цепочку.
       * @returns Result of the remaining chain. / Результат оставшейся цепочки.
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
