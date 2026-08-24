import { WebSocketProtocolError } from './errors.js';

const WIRE_NAME = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCompatible(value, ancestors = new WeakSet()) {
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

export function decodeWebSocketMessage(text) {
  let value;
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
    !Reflect.ownKeys(value).every((key) => ['body', 'controller', 'event'].includes(key)) ||
    value.body === null ||
    typeof value.body !== 'object' ||
    Array.isArray(value.body)
  ) {
    throw new WebSocketProtocolError('INVALID_MESSAGE', {
      controller: value.controller,
      event: value.event,
    });
  }
  return value;
}

export function encodeWebSocketMessage(
  controller,
  event,
  body,
  maxPayload = Number.MAX_SAFE_INTEGER,
) {
  if (!isPlainObject(body) || Object.hasOwn(body, 'error') || !isCompatible(body)) {
    throw new WebSocketProtocolError('INVALID_RESPONSE', { controller, event });
  }
  const text = JSON.stringify({ controller, event, body });
  if (Buffer.byteLength(text) > maxPayload) {
    throw new WebSocketProtocolError('INVALID_RESPONSE', { controller, event });
  }
  return text;
}

export function encodeWebSocketError(
  controller,
  event,
  code,
  maxPayload = Number.MAX_SAFE_INTEGER,
) {
  const text = JSON.stringify({ controller, event, body: { error: { code } } });
  if (Buffer.byteLength(text) > maxPayload) {
    throw new WebSocketProtocolError('INVALID_RESPONSE', { controller, event });
  }
  return text;
}
