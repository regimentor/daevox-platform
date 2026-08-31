import { EventListenerBase } from './EventListenerBase.ts';
import type { ApplicationEventHandler, EventListenerDependencies } from './EventListenerBase.ts';
import type { AppStateInstance } from './Application.ts';
import { EventListenerConflictError, InvalidEventListenerError } from './errors.ts';

/** Constructable application-event DTO. / Создаваемый DTO внутреннего события. @public */
export type ApplicationEventDataClass<Data = unknown> = new (...args: any[]) => Data;

/** Declarative application-event metadata. / Метаданные внутреннего события. @public */
export interface ApplicationEventDeclaration<
  Data = unknown,
  TAppState extends object = AppStateInstance,
> {
  name: string;
  data: ApplicationEventDataClass<Data>;
  handler: string & keyof Record<string, ApplicationEventHandler<Data, TAppState>>;
}

/** Event-listener class accepted for registration. / Класс listener внутренних событий для регистрации. @public */
export type EventListenerClass<TAppState extends object = AppStateInstance> = {
  new (dependencies: EventListenerDependencies): EventListenerBase;
  readonly name: string;
  readonly events: readonly ApplicationEventDeclaration<unknown, TAppState>[];
};

/** Validated event declaration. / Проверенная декларация внутреннего события. @private */
export interface NormalizedEventDeclaration {
  readonly name: string;
  readonly data: ApplicationEventDataClass<any>;
  readonly handler: string;
}

/** Validated listener metadata. / Проверенные метаданные слушателя событий. @private */
export interface NormalizedEventListener {
  readonly name: string;
  readonly EventListener: EventListenerClass<any>;
  readonly events: readonly NormalizedEventDeclaration[];
}

/**
 * Wire-name syntax for listener and event addresses.
 * Синтаксис wire-имён слушателей и внутренних событий.
 * @private
 */
const WIRE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Reads an explicitly declared static field without invoking accessors.
 * Читает явно объявленное статическое поле без вызова аксессоров.
 * @param owner Declaring class. / Объявляющий класс.
 * @param key Field name. / Имя поля.
 * @returns Declared value. / Объявленное значение.
 * @private
 */
function declaredStaticField(owner: Function, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * Checks whether a value is a constructable DTO class.
 * Проверяет, является ли значение создаваемым классом DTO.
 * @param value Candidate. / Проверяемое значение.
 * @returns Whether the value is constructable. / Можно ли создать экземпляр.
 * @private
 */
function isConstructor(value: unknown): value is ApplicationEventDataClass {
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
 * @param EventListener Listener class. / Класс слушателя.
 * @param declaration Event declaration. / Декларация события.
 * @returns Frozen declaration. / Замороженная декларация.
 * @private
 */
function normalizeDeclaration(
  EventListener: EventListenerClass<any>,
  declaration: any,
): NormalizedEventDeclaration {
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
 * @private
 */
export class EventListenerRegistry {
  /**
   * Listener metadata by name. / Метаданные по имени.
   * @private
   */
  #listeners = new Map<string, NormalizedEventListener>();
  /**
   * Registered classes. / Зарегистрированные классы.
   * @private
   */
  #classes = new Set<EventListenerClass<any>>();

  /**
   * Validates, snapshots, and registers a listener class atomically.
   * Атомарно проверяет, копирует и регистрирует класс слушателя.
   * @param EventListener Candidate class. / Проверяемый класс.
   * @private
   */
  register(EventListener: EventListenerClass<any>): void {
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
    const normalizedEvents = events.map((declaration: any) =>
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
   * @returns Metadata iterator. / Итератор метаданных.
   * @private
   */
  values(): MapIterator<NormalizedEventListener> {
    return this.#listeners.values();
  }

  /**
   * Resolves one exact listener/event address.
   * Разрешает один точный адрес listener/event.
   * @param listener Listener name. / Имя слушателя.
   * @param event Event name. / Имя события.
   * @returns Match. / Совпадение.
   * @private
   */
  resolve(
    listener: string,
    event: string,
  ): { listener: NormalizedEventListener; event: NormalizedEventDeclaration } | undefined {
    const listenerMetadata = this.#listeners.get(listener);
    if (!listenerMetadata) return undefined;
    const eventMetadata = listenerMetadata.events.find((candidate) => candidate.name === event);
    if (!eventMetadata) return undefined;
    return { listener: listenerMetadata, event: eventMetadata };
  }
}
