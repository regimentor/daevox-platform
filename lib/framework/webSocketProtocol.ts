import { WebSocketProtocolError } from './errors.ts';

/** Decoded `daevox.v1` message. / Декодированное сообщение `daevox.v1`. @private */
export interface WebSocketProtocolMessage<Body extends object = Record<string, unknown>> {
  controller: string;
  event: string;
  body: Body;
}

/**

 * Valid controller and event wire-name syntax. / Допустимый синтаксис сетевых имён контроллеров и событий.

 *
 * @private

 */
const WIRE_NAME = /^[A-Za-z0-9_-]+$/;

/**

 * Tests whether a value is a plain object. / Проверяет, является ли значение простым объектом.

 *
 * @param value Candidate value. / Проверяемое значение.

 * @returns Validation result. / Результат проверки.

 * @private

 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**

 * Recursively checks strict JSON compatibility without cycles or accessors. / Рекурсивно проверяет строгую JSON-совместимость без циклов и аксессоров.

 *
 * @param value Candidate value. / Проверяемое значение.

 * @param [ancestors] Current ancestors. / Текущие предки.

 * @returns Compatibility result. / Результат проверки.

 * @private

 */
function isCompatible(value: unknown, ancestors: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let compatible = true;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    compatible =
      keys.length === value.length + 1 &&
      keys.includes('length') &&
      Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor?.enumerable &&
          'value' in descriptor &&
          isCompatible(descriptor.value, ancestors)
        );
      });
  } else if (isPlainObject(value)) {
    compatible = Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor?.enumerable && 'value' in descriptor && isCompatible(descriptor.value, ancestors)
      );
    });
  } else {
    compatible = false;
  }
  ancestors.delete(value);
  return compatible;
}

/**

 * Decodes and validates an inbound `daevox.v1` text message. / Декодирует и проверяет входящее текстовое сообщение `daevox.v1`.

 *
 * @param text JSON text. / JSON-текст.

 * @returns Decoded message. / Декодированное сообщение.

 * @throws {WebSocketProtocolError} For invalid protocol input. / При некорректных данных протокола.

 * @private

 */
export function decodeWebSocketMessage(text: string): WebSocketProtocolMessage {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WebSocketProtocolError('INVALID_MESSAGE', { fatal: true });
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.controller !== 'string' ||
    !WIRE_NAME.test(value.controller) ||
    typeof value.event !== 'string' ||
    !WIRE_NAME.test(value.event)
  ) {
    throw new WebSocketProtocolError('INVALID_MESSAGE', { fatal: true });
  }
  if (
    Reflect.ownKeys(value).length !== 3 ||
    !Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && ['body', 'controller', 'event'].includes(key),
    ) ||
    value.body === null ||
    typeof value.body !== 'object' ||
    Array.isArray(value.body)
  ) {
    throw new WebSocketProtocolError('INVALID_MESSAGE', {
      controller: value.controller,
      event: value.event,
    });
  }
  return value as WebSocketProtocolMessage;
}

/**

 * Encodes a successful `daevox.v1` response. / Кодирует успешный ответ `daevox.v1`.

 *
 * @param controller Controller wire name. / Сетевое имя контроллера.

 * @param event Event wire name. / Сетевое имя события.

 * @param body Response body. / Тело ответа.

 * @param [maxPayload] Maximum encoded bytes. / Максимум байтов.

 * @returns Encoded JSON message. / Кодированное JSON-сообщение.

 * @private

 */
export function encodeWebSocketMessage(
  controller: string,
  event: string,
  body: object,
  maxPayload = Number.MAX_SAFE_INTEGER,
): string {
  if (
    typeof controller !== 'string' ||
    !WIRE_NAME.test(controller) ||
    typeof event !== 'string' ||
    !WIRE_NAME.test(event) ||
    !isPlainObject(body) ||
    Object.hasOwn(body, 'error') ||
    !isCompatible(body)
  ) {
    throw new WebSocketProtocolError('INVALID_RESPONSE', { controller, event });
  }
  const text = JSON.stringify({ controller, event, body });
  if (Buffer.byteLength(text) > maxPayload) {
    throw new WebSocketProtocolError('INVALID_RESPONSE', { controller, event });
  }
  return text;
}

/**

 * Encodes an addressed `daevox.v1` error response. / Кодирует адресованный ответ с ошибкой `daevox.v1`.

 *
 * @param controller Controller wire name. / Сетевое имя контроллера.

 * @param event Event wire name. / Сетевое имя события.

 * @param code Protocol or application error code. / Код ошибки протокола или приложения.

 * @param [maxPayload] Maximum encoded bytes. / Максимум байтов.

 * @returns Encoded JSON message. / Кодированное JSON-сообщение.

 * @private

 */
export function encodeWebSocketError(
  controller: string,
  event: string,
  code: string,
  maxPayload = Number.MAX_SAFE_INTEGER,
): string {
  const text = JSON.stringify({ controller, event, body: { error: { code } } });
  if (Buffer.byteLength(text) > maxPayload) {
    throw new WebSocketProtocolError('INVALID_RESPONSE', { controller, event });
  }
  return text;
}
