import { InvalidWebSocketControllerError, WebSocketControllerConflictError } from './errors.js';
import { WebSocketControllerBase } from './WebSocketControllerBase.js';

const WIRE_NAME = /^[A-Za-z0-9_-]+$/;

function invalid(message) {
  throw new InvalidWebSocketControllerError(message);
}

export class WebSocketControllerRegistry {
  #controllers = new Map();

  register(WebSocketController) {
    if (
      typeof WebSocketController !== 'function' ||
      !WebSocketController.prototype ||
      Object.getPrototypeOf(WebSocketController.prototype) !== WebSocketControllerBase.prototype
    ) {
      invalid('WebSocket controller must directly extend WebSocketControllerBase');
    }
    const nameDescriptor = Object.getOwnPropertyDescriptor(WebSocketController, 'name');
    const eventsDescriptor = Object.getOwnPropertyDescriptor(WebSocketController, 'events');
    const name =
      nameDescriptor &&
      'value' in nameDescriptor &&
      nameDescriptor.writable &&
      nameDescriptor.enumerable
        ? nameDescriptor.value
        : undefined;
    const events =
      eventsDescriptor && 'value' in eventsDescriptor ? eventsDescriptor.value : undefined;
    if (typeof name !== 'string' || !WIRE_NAME.test(name)) {
      invalid('WebSocket controller must have its own valid name');
    }
    if (!Array.isArray(events) || events.length === 0) {
      invalid('WebSocket controller must have its own non-empty events array');
    }
    const normalizedEvents = new Map();
    for (const event of events) {
      if (
        event === null ||
        typeof event !== 'object' ||
        Array.isArray(event) ||
        Reflect.ownKeys(event).length !== 2 ||
        !Reflect.ownKeys(event).every((key) => ['handler', 'name'].includes(key)) ||
        typeof event.name !== 'string' ||
        !WIRE_NAME.test(event.name) ||
        typeof event.handler !== 'string' ||
        event.handler === ''
      ) {
        invalid('WebSocket event must have exactly valid name and handler fields');
      }
      const handler = Object.getOwnPropertyDescriptor(WebSocketController.prototype, event.handler);
      if (event.handler === 'constructor' || !handler || typeof handler.value !== 'function') {
        invalid('WebSocket event handler must be an own instance method');
      }
      if (normalizedEvents.has(event.name)) {
        invalid('WebSocket event names must be unique within a controller');
      }
      normalizedEvents.set(event.name, event.handler);
    }
    if (this.#controllers.has(name)) {
      throw new WebSocketControllerConflictError(`WebSocket controller conflicts with ${name}`);
    }
    this.#controllers.set(name, { controller: WebSocketController, events: normalizedEvents });
  }

  resolve(controllerName, eventName) {
    const entry = this.#controllers.get(controllerName);
    if (!entry) return null;
    const handler = entry.events.get(eventName);
    if (!handler) return { controller: entry.controller };
    return { controller: entry.controller, handler };
  }
}
