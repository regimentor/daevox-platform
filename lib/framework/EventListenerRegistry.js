import { EventListenerBase } from './EventListenerBase.js';
import { EventListenerConflictError, InvalidEventListenerError } from './errors.js';

/**
 * Wire-name syntax for listener and event addresses.
 * Синтаксис wire-имён слушателей и внутренних событий.
 *
 * @type {RegExp}
 * @private
 */
const WIRE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Reads an explicitly declared static field without invoking accessors.
 * Читает явно объявленное статическое поле без вызова аксессоров.
 *
 * @param {Function} owner Declaring class. / Объявляющий класс.
 * @param {string} key Field name. / Имя поля.
 * @returns {*} Declared value. / Объявленное значение.
 * @private
 */
function declaredStaticField(owner, key) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * Checks whether a value is a constructable DTO class.
 * Проверяет, является ли значение создаваемым классом DTO.
 *
 * @param {*} value Candidate. / Проверяемое значение.
 * @returns {boolean} Whether the value is constructable. / Можно ли создать экземпляр.
 * @private
 */
function isConstructor(value) {
  if (typeof value !== 'function') return false;
  try {
    Reflect.construct(Object, [], value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates and snapshots one event declaration.
 * Проверяет и копирует одну декларацию внутреннего события.
 *
 * @param {Function} EventListener Listener class. / Класс слушателя.
 * @param {*} declaration Event declaration. / Декларация события.
 * @returns {NormalizedEventDeclaration} Frozen declaration. / Замороженная декларация.
 * @private
 */
function normalizeDeclaration(EventListener, declaration) {
  if (
    declaration === null ||
    typeof declaration !== 'object' ||
    Array.isArray(declaration) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(declaration)) ||
    Reflect.ownKeys(declaration).length !== 3
  ) {
    throw new InvalidEventListenerError(
      'Event declaration must contain exactly name, data, handler',
    );
  }
  for (const key of ['name', 'data', 'handler']) {
    const descriptor = Object.getOwnPropertyDescriptor(declaration, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new InvalidEventListenerError('Event declaration fields must be own data properties');
    }
  }
  const { name, data, handler } = declaration;
  if (typeof name !== 'string' || !WIRE_NAME.test(name)) {
    throw new InvalidEventListenerError('Event name is invalid');
  }
  if (!isConstructor(data)) {
    throw new InvalidEventListenerError('Event data must be a DTO class');
  }
  if (typeof handler !== 'string' || handler === '' || handler === 'constructor') {
    throw new InvalidEventListenerError('Event handler name is invalid');
  }
  const handlerDescriptor = Object.getOwnPropertyDescriptor(EventListener.prototype, handler);
  if (!handlerDescriptor || typeof handlerDescriptor.value !== 'function') {
    throw new InvalidEventListenerError('Event handler must be an own prototype method');
  }
  return Object.freeze({ name, data, handler });
}

/**
 * Internal immutable catalog of addressed application-event declarations.
 * Внутренний неизменяемый каталог деклараций адресуемых событий приложения.
 *
 * @private
 */
export class EventListenerRegistry {
  /**
   * @type {Map<string, NormalizedEventListener>} Listener metadata by name. / Метаданные по имени.
   * @private
   */
  #listeners = new Map();
  /**
   * @type {Set<Function>} Registered classes. / Зарегистрированные классы.
   * @private
   */
  #classes = new Set();

  /**
   * Validates, snapshots, and registers a listener class atomically.
   * Атомарно проверяет, копирует и регистрирует класс слушателя.
   *
   * @param {Function} EventListener Candidate class. / Проверяемый класс.
   * @returns {void}
   * @private
   */
  register(EventListener) {
    if (this.#classes.has(EventListener)) {
      throw new EventListenerConflictError('Event listener class has already been registered');
    }
    if (
      typeof EventListener !== 'function' ||
      !EventListener.prototype ||
      Object.getPrototypeOf(EventListener.prototype) !== EventListenerBase.prototype
    ) {
      throw new InvalidEventListenerError('Event listener must directly extend EventListenerBase');
    }
    const name = declaredStaticField(EventListener, 'name');
    const events = declaredStaticField(EventListener, 'events');
    if (typeof name !== 'string' || !WIRE_NAME.test(name)) {
      throw new InvalidEventListenerError('Event listener must declare a valid own static name');
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new InvalidEventListenerError(
        'Event listener must declare a non-empty own static events array',
      );
    }
    for (let index = 0; index < events.length; index += 1) {
      if (!Object.hasOwn(events, index)) {
        throw new InvalidEventListenerError('Event listener events array must not be sparse');
      }
    }
    const normalizedEvents = events.map((declaration) =>
      normalizeDeclaration(EventListener, declaration),
    );
    const eventNames = new Set(normalizedEvents.map((event) => event.name));
    if (eventNames.size !== normalizedEvents.length) {
      throw new EventListenerConflictError('Event listener contains duplicate event addresses');
    }
    if (this.#listeners.has(name)) {
      throw new EventListenerConflictError('Event listener name has already been registered');
    }
    this.#classes.add(EventListener);
    this.#listeners.set(
      name,
      Object.freeze({ name, EventListener, events: Object.freeze(normalizedEvents) }),
    );
  }

  /**
   * Returns immutable registered listener metadata.
   * Возвращает неизменяемые метаданные зарегистрированных слушателей.
   *
   * @returns {IterableIterator<NormalizedEventListener>} Metadata iterator. / Итератор метаданных.
   * @private
   */
  values() {
    return this.#listeners.values();
  }

  /**
   * Resolves one exact listener/event address.
   * Разрешает один точный адрес listener/event.
   *
   * @param {string} listener Listener name. / Имя слушателя.
   * @param {string} event Event name. / Имя события.
   * @returns {{listener: NormalizedEventListener, event: NormalizedEventDeclaration}|undefined} Match. / Совпадение.
   * @private
   */
  resolve(listener, event) {
    const listenerMetadata = this.#listeners.get(listener);
    if (!listenerMetadata) return undefined;
    const eventMetadata = listenerMetadata.events.find((candidate) => candidate.name === event);
    if (!eventMetadata) return undefined;
    return { listener: listenerMetadata, event: eventMetadata };
  }
}

/**
 * Frozen event declaration stored by the registry.
 * Замороженная декларация события в каталоге.
 *
 * @typedef {Object} NormalizedEventDeclaration
 * @property {string} name Event wire name. / Wire-имя события.
 * @property {Function} data DTO class. / Класс DTO.
 * @property {string} handler Listener method name. / Имя метода слушателя.
 * @private
 */

/**
 * Frozen listener metadata stored by the registry.
 * Замороженные метаданные слушателя в каталоге.
 *
 * @typedef {Object} NormalizedEventListener
 * @property {string} name Listener wire name. / Wire-имя слушателя.
 * @property {Function} EventListener Listener class. / Класс слушателя.
 * @property {NormalizedEventDeclaration[]} events Event declarations. / Декларации событий.
 * @private
 */
