import { types as utilTypes } from 'node:util';
import {
  HttpRouteJsonBodyValidationError,
  InvalidHttpRouteJsonBodyContractError,
  type HttpRouteJsonBodyFrameworkViolationCode,
  type HttpRouteJsonBodyViolation,
} from './errors.ts';

/** Constructable application class used as an HTTP-route JSON body contract. / Конструируемый прикладной класс контракта JSON-тела HTTP-маршрута. @public */
export type HttpRouteJsonBodyClass<Body extends object = object> = {
  new (): Body;
  readonly schema: HttpRouteJsonBodySchema<Body>;
  readonly validators?: readonly HttpRouteJsonBodyRootValidator<Body>[];
};

/** Opaque deferred application-class descriptor. / Непрозрачный отложенный descriptor прикладного класса. @public */
export interface HttpRouteJsonBodyClassReference<Body extends object = object> {
  readonly __bodyClass?: Body;
}

/** Deferred class resolvers by opaque descriptor identity. / Отложенные resolver классов по identity непрозрачного descriptor. @private */
const BODY_CLASS_RESOLVERS = new WeakMap<object, () => HttpRouteJsonBodyClass>();

/**
 * Creates a deferred descriptor for self and forward class references.
 * Создаёт отложенный descriptor для self- и forward-ссылок на классы.
 * @param resolver Pure class resolver. / Чистый resolver класса.
 * @returns Opaque class descriptor. / Непрозрачный descriptor класса.
 * @public
 */
export function bodyClass<Body extends object>(
  resolver: () => HttpRouteJsonBodyClass<Body>,
): HttpRouteJsonBodyClassReference<Body> {
  const reference = Object.freeze(Object.create(null)) as HttpRouteJsonBodyClassReference<Body>;
  BODY_CLASS_RESOLVERS.set(reference, resolver as () => HttpRouteJsonBodyClass);
  return reference;
}

/** Removes absence/nullability before selecting a descriptor. / Убирает отсутствие/nullability перед выбором descriptor. @private */
type Present<Value> = Exclude<Value, null | undefined>;

/** Whether two types are mutually assignable. / Являются ли два типа взаимно присваиваемыми. @private */
type IsExact<Value, Expected> = [Value] extends [Expected]
  ? [Expected] extends [Value]
    ? true
    : false
  : false;

/** Descriptor corresponding to one supported TypeScript data field. / Descriptor одного поддерживаемого TypeScript data field. @public */
export type HttpRouteJsonBodyDescriptor<Value> = [Value] extends [null]
  ? null
  : IsExact<Present<Value>, string> extends true
    ? StringConstructor
    : IsExact<Present<Value>, number> extends true
      ? NumberConstructor
      : IsExact<Present<Value>, boolean> extends true
        ? BooleanConstructor
        : Present<Value> extends readonly (infer Element)[]
          ? number extends Present<Value>['length']
            ? readonly [HttpRouteJsonBodyDescriptor<Element>]
            : never
          : Present<Value> extends object
            ?
                | HttpRouteJsonBodyClass<Present<Value>>
                | HttpRouteJsonBodyClassReference<Present<Value>>
            : never;

/** Nullability metadata required by a field type. / Метаданные nullability, требуемые типом поля. @private */
type FieldNullability<Value> = [Value] extends [null]
  ? { readonly nullable?: never }
  : null extends Value
    ? { readonly nullable: true }
    : { readonly nullable?: never };

/** One schema field declaration. / Одно объявление поля schema. @public */
export type HttpRouteJsonBodyField<Value> = {
  readonly type: HttpRouteJsonBodyDescriptor<Value>;
  readonly validators?: readonly HttpRouteJsonBodyFieldValidator<Present<Value>>[];
} & FieldNullability<Value>;

/** Public non-function data keys of a contract class. / Публичные non-function data keys класса контракта. @private */
type HttpRouteJsonBodyDataKey<Body extends object> = {
  [Key in keyof Body]-?: Body[Key] extends (...args: any[]) => unknown ? never : Key;
}[keyof Body];

/** Exhaustive schema corresponding to an application body class. / Исчерпывающая schema прикладного класса тела. @public */
export type HttpRouteJsonBodySchema<Body extends object> = {
  readonly [Key in HttpRouteJsonBodyDataKey<Body>]-?: HttpRouteJsonBodyField<Body[Key]>;
};

/** Failure returned by an application validator. / Нарушение, возвращаемое прикладным validator. @public */
export interface HttpRouteJsonBodyValidatorFailure {
  readonly code: string;
  readonly message: string;
}

/** Failure returned by a class-level validator. / Нарушение, возвращаемое class-level validator. @public */
export interface HttpRouteJsonBodyRootValidatorFailure extends HttpRouteJsonBodyValidatorFailure {
  readonly path?: readonly (string | number)[];
}

/** Deep readonly JSON projection of application data fields. / Глубокая readonly JSON-проекция прикладных data fields. @public */
export type HttpRouteJsonBodyInput<Value> = Value extends string | number | boolean | null
  ? Value
  : Value extends readonly (infer Element)[]
    ? readonly HttpRouteJsonBodyInput<Element>[]
    : Value extends object
      ? {
          readonly [
            Key in keyof Value as Value[Key] extends (...args: any[]) => unknown ? never : Key
          ]: HttpRouteJsonBodyInput<Exclude<Value[Key], undefined>>;
        }
      : never;

/** Synchronous validator of a complete class subtree. / Синхронный validator полного subtree класса. @public */
export type HttpRouteJsonBodyRootValidator<Body extends object> = (
  body: HttpRouteJsonBodyInput<Body>,
) =>
  | HttpRouteJsonBodyRootValidatorFailure
  | readonly HttpRouteJsonBodyRootValidatorFailure[]
  | undefined;

/** Frozen location passed to a field validator. / Замороженное положение, передаваемое field validator. @public */
export interface HttpRouteJsonBodyValidationContext {
  readonly path: readonly (string | number)[];
}

/** Synchronous validator of one present non-null field. / Синхронный validator одного присутствующего non-null поля. @public */
export type HttpRouteJsonBodyFieldValidator<Value> = (
  value: Value,
  context: HttpRouteJsonBodyValidationContext,
) => HttpRouteJsonBodyValidatorFailure | undefined;

/** Framework metadata attached out-of-band to built-in validators. / Метаданные framework, связанные с built-in validators вне функции. @private */
interface BuiltInValidatorMetadata {
  readonly required: boolean;
  readonly target: 'any' | 'length' | 'number';
}

/** Built-in validator metadata by callable identity. / Метаданные built-in validator по identity функции. @private */
const BUILT_IN_VALIDATORS = new WeakMap<Function, BuiltInValidatorMetadata>();

/** Framework-owned violation codes unavailable to custom validators. / Принадлежащие framework коды violations, недоступные custom validators. @private */
const RESERVED_VIOLATION_CODES: ReadonlySet<string> =
  new Set<HttpRouteJsonBodyFrameworkViolationCode>([
    'INVALID_TYPE',
    'NULL_NOT_ALLOWED',
    'UNKNOWN_FIELD',
    'MAX_DEPTH',
    'MAX_VALUES',
    'TOO_MANY_VIOLATIONS',
    'REQUIRED',
    'MIN_LENGTH',
    'MAX_LENGTH',
    'MIN',
    'MAX',
    'INTEGER',
  ]);

/** Throws a registration-time body-contract error. / Выбрасывает registration-time ошибку body contract. @private */
function invalidContract(message: string, cause?: unknown): never {
  throw new InvalidHttpRouteJsonBodyContractError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

/** Safely snapshots a dense metadata array without invoking accessors. / Безопасно копирует плотный массив metadata без вызова accessors. @private */
function snapshotMetadataArray(
  value: unknown,
  maximumLength: number,
  message: string,
): readonly unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) invalidContract(message);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : -1;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) {
    invalidContract(message);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    keys.some(
      (key) =>
        key !== 'length' &&
        (typeof key !== 'string' ||
          !Number.isSafeInteger(Number(key)) ||
          String(Number(key)) !== key),
    )
  ) {
    invalidContract(message);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) invalidContract(message);
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

/** Validates one custom validator failure. / Проверяет одно нарушение custom validator. @private */
function validateCustomFailure(
  failure: unknown,
  root: boolean,
): asserts failure is HttpRouteJsonBodyRootValidatorFailure {
  if (
    failure === null ||
    typeof failure !== 'object' ||
    Array.isArray(failure) ||
    utilTypes.isProxy(failure)
  ) {
    throw new TypeError('HTTP route JSON body validator returned an invalid failure');
  }
  const keys = Reflect.ownKeys(failure);
  if (
    !keys.includes('code') ||
    !keys.includes('message') ||
    keys.some(
      (key) =>
        typeof key !== 'string' || !['code', 'message', ...(root ? ['path'] : [])].includes(key),
    )
  ) {
    throw new TypeError('HTTP route JSON body validator returned an invalid failure');
  }
  const candidate = failure as Record<string, unknown>;
  if (
    typeof candidate.code !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.code) ||
    RESERVED_VIOLATION_CODES.has(candidate.code) ||
    typeof candidate.message !== 'string' ||
    [...candidate.message].length < 1 ||
    [...candidate.message].length > 512
  ) {
    throw new TypeError('HTTP route JSON body validator returned an invalid failure');
  }
  if (
    Object.hasOwn(candidate, 'path') &&
    (!Array.isArray(candidate.path) ||
      utilTypes.isProxy(candidate.path) ||
      candidate.path.some(
        (segment) =>
          typeof segment !== 'string' &&
          !(typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0),
      ))
  ) {
    throw new TypeError('HTTP route JSON body validator returned an invalid path');
  }
}

/** Creates and marks one built-in validator. / Создаёт и помечает один built-in validator. @private */
function builtIn<Value>(
  validator: HttpRouteJsonBodyFieldValidator<Value>,
  target: BuiltInValidatorMetadata['target'],
  presenceValidator = false,
): HttpRouteJsonBodyFieldValidator<Value> {
  BUILT_IN_VALIDATORS.set(validator, Object.freeze({ required: presenceValidator, target }));
  return validator;
}

/** Requires a field to be present. / Требует присутствия поля. @public */
export function required<Value>(): HttpRouteJsonBodyFieldValidator<Value> {
  return builtIn(() => undefined, 'any', true);
}

/** Validates and normalizes a length bound. / Проверяет и нормализует границу длины. @private */
function lengthBound(bound: number): number {
  if (!Number.isSafeInteger(bound) || bound < 0) throw new TypeError('length bound is invalid');
  return Object.is(bound, -0) ? 0 : bound;
}

/** Validates and normalizes a numeric bound. / Проверяет и нормализует числовую границу. @private */
function numberBound(bound: number): number {
  if (!Number.isFinite(bound)) throw new TypeError('numeric bound is invalid');
  return Object.is(bound, -0) ? 0 : bound;
}

/** Requires a string or array to have at least the given length. / Требует минимальную длину строки или массива. @public */
export function minLength<Value extends string | readonly unknown[]>(
  bound: number,
): HttpRouteJsonBodyFieldValidator<Value> {
  bound = lengthBound(bound);
  return builtIn(
    (value) =>
      [...value].length < bound
        ? { code: 'MIN_LENGTH', message: `Must have length at least ${bound}` }
        : undefined,
    'length',
  );
}

/** Requires a string or array to have at most the given length. / Требует максимальную длину строки или массива. @public */
export function maxLength<Value extends string | readonly unknown[]>(
  bound: number,
): HttpRouteJsonBodyFieldValidator<Value> {
  bound = lengthBound(bound);
  return builtIn(
    (value) =>
      [...value].length > bound
        ? { code: 'MAX_LENGTH', message: `Must have length at most ${bound}` }
        : undefined,
    'length',
  );
}

/** Requires a number to be at least the given bound. / Требует число не меньше заданной границы. @public */
export function min(bound: number): HttpRouteJsonBodyFieldValidator<number> {
  bound = numberBound(bound);
  return builtIn(
    (value) =>
      value < bound
        ? { code: 'MIN', message: `Must be greater than or equal to ${bound}` }
        : undefined,
    'number',
  );
}

/** Requires a number to be at most the given bound. / Требует число не больше заданной границы. @public */
export function max(bound: number): HttpRouteJsonBodyFieldValidator<number> {
  bound = numberBound(bound);
  return builtIn(
    (value) =>
      value > bound
        ? { code: 'MAX', message: `Must be less than or equal to ${bound}` }
        : undefined,
    'number',
  );
}

/** Requires a number to be an integer. / Требует целое число. @public */
export function integer(): HttpRouteJsonBodyFieldValidator<number> {
  return builtIn(
    (value) =>
      Number.isInteger(value) ? undefined : { code: 'INTEGER', message: 'Must be an integer' },
    'number',
  );
}

/** Compiled request-local JSON body contract. / Скомпилированный request-local контракт JSON-тела. @private */
export interface CompiledHttpRouteJsonBodyContract<Body extends object = object> {
  /** Converts parsed JSON into an application instance. / Преобразует разобранный JSON в прикладной экземпляр. @private */
  materialize(input: unknown): Body;
  /** Collects structural violations. / Собирает structural-нарушения. @private */
  validateStructure(
    input: unknown,
    path: readonly (string | number)[],
    violations: HttpRouteJsonBodyViolation[],
    context: StructuralValidationContext,
  ): void;
  /** Runs field validators depth-first. / Выполняет field validators depth-first. @private */
  validateFields(
    input: unknown,
    path: readonly (string | number)[],
    violations: HttpRouteJsonBodyViolation[],
  ): void;
  /** Runs class validators bottom-up. / Выполняет class validators bottom-up. @private */
  validateRoots(
    input: unknown,
    path: readonly (string | number)[],
    violations: HttpRouteJsonBodyViolation[],
  ): void;
  /** Materializes already validated input. / Материализует уже проверенный input. @private */
  materializeValue(input: unknown): Body;
  /** Checks a validator-relative path against schema and input. / Проверяет относительный path validator по schema и input. @private */
  resolvesInputPath(input: unknown, path: readonly (string | number)[]): boolean;
}

/** Counters shared by one structural traversal. / Счётчики одного structural traversal. @private */
interface StructuralValidationContext {
  values: number;
  maxValuesExceeded: boolean;
}

/** Compiled behavior of one recursive descriptor. / Скомпилированное поведение одного рекурсивного descriptor. @private */
interface CompiledDescriptor {
  readonly expected: string;
  readonly target: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
  readonly contract?: CompiledHttpRouteJsonBodyContract;
  readonly materialize: (input: unknown) => unknown;
  readonly validateStructure: (
    input: unknown,
    path: readonly (string | number)[],
    violations: HttpRouteJsonBodyViolation[],
    context: StructuralValidationContext,
  ) => void;
  readonly validateFields: (
    input: unknown,
    path: readonly (string | number)[],
    violations: HttpRouteJsonBodyViolation[],
  ) => void;
  readonly validateRoots: (
    input: unknown,
    path: readonly (string | number)[],
    violations: HttpRouteJsonBodyViolation[],
  ) => void;
  readonly resolvesInputPath: (input: unknown, path: readonly (string | number)[]) => boolean;
}

/** Aggregate counters and caches owned by one root compilation. / Совокупные счётчики и caches одной root compilation. @private */
interface CompilationContext {
  readonly contracts: Map<Function, CompiledHttpRouteJsonBodyContract>;
  readonly classes: Set<Function>;
  readonly resolvedClasses: WeakMap<object, HttpRouteJsonBodyClass>;
  fieldCount: number;
  validatorReferences: number;
}

/** Direct graph metadata retained with a published compiled contract. / Прямые метаданные графа опубликованного compiled contract. @private */
interface CompiledContractMetadata {
  readonly BodyClass: Function;
  readonly fieldCount: number;
  readonly validatorReferences: number;
  readonly dependencies: readonly CompiledHttpRouteJsonBodyContract[];
}

/** Graph metadata by compiled contract identity. / Метаданные графа по identity compiled contract. @private */
const COMPILED_CONTRACT_METADATA = new WeakMap<
  CompiledHttpRouteJsonBodyContract,
  CompiledContractMetadata
>();

/** Accounts one class and enforces graph-wide compilation limits. / Учитывает один класс и применяет graph-wide limits compilation. @private */
function accountClass(
  context: CompilationContext,
  BodyClass: Function,
  fieldCount: number,
  validatorReferences: number,
): boolean {
  if (context.classes.has(BodyClass)) return false;
  context.classes.add(BodyClass);
  if (context.classes.size > 128) {
    invalidContract('HTTP route JSON body contract graph exceeds 128 classes');
  }
  context.fieldCount += fieldCount;
  if (context.fieldCount > 1024) {
    invalidContract('HTTP route JSON body contract graph exceeds 1024 schema fields');
  }
  context.validatorReferences += validatorReferences;
  if (context.validatorReferences > 4096) {
    invalidContract('HTTP route JSON body contract graph exceeds 4096 validator references');
  }
  return true;
}

/** Accounts a previously compiled contract graph without resolving metadata again. / Учитывает ранее compiled graph без повторного разрешения metadata. @private */
function accountCompiledGraph(
  contract: CompiledHttpRouteJsonBodyContract,
  context: CompilationContext,
): void {
  const pending = [contract];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const metadata = COMPILED_CONTRACT_METADATA.get(current);
    if (!metadata) continue;
    if (
      accountClass(context, metadata.BodyClass, metadata.fieldCount, metadata.validatorReferences)
    ) {
      pending.push(...metadata.dependencies);
    }
  }
}

/** Encodes path segments as RFC 6901 JSON Pointer. / Кодирует сегменты path как RFC 6901 JSON Pointer. @private */
function pointer(path: readonly (string | number)[]): string {
  return path
    .map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

/** Adds a structural type violation. / Добавляет structural-нарушение типа. @private */
function invalidType(
  path: readonly (string | number)[],
  expected: string,
  violations: HttpRouteJsonBodyViolation[],
): void {
  violations.push({ path: pointer(path), code: 'INVALID_TYPE', message: `Expected ${expected}` });
}

/** Deeply freezes a parsed JSON graph without recursion. / Глубоко замораживает разобранный JSON-граф без рекурсии. @private */
function freezeJson(input: unknown): void {
  if (input === null || typeof input !== 'object') return;
  const pending: object[] = [input];
  while (pending.length > 0) {
    const value = pending.pop()!;
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
        pending.push(child);
      }
    }
    Object.freeze(value);
  }
}

/** Accounts one value before structurally validating it. / Учитывает одно значение перед structural validation. @private */
function visitStructuralValue(
  path: readonly (string | number)[],
  violations: HttpRouteJsonBodyViolation[],
  context: StructuralValidationContext,
): boolean {
  if (context.maxValuesExceeded) return false;
  context.values += 1;
  if (context.values > 100_000) {
    context.maxValuesExceeded = true;
    violations.push({
      path: '',
      code: 'MAX_VALUES',
      message: 'Maximum JSON value count exceeded',
    });
    return false;
  }
  if (path.length >= 64) {
    violations.push({
      path: pointer(path),
      code: 'MAX_DEPTH',
      message: 'Maximum JSON depth exceeded',
    });
    return false;
  }
  return true;
}

/**
 * Compiles one recursive field descriptor.
 * Компилирует один рекурсивный descriptor поля.
 * @param descriptor Declared descriptor. / Объявленный descriptor.
 * @returns Descriptor plan. / План descriptor.
 * @private
 */
function compileDescriptor(
  descriptor: unknown,
  context: CompilationContext,
  depth = 1,
): CompiledDescriptor {
  if (depth > 32) invalidContract('HTTP route JSON body descriptor depth exceeds 32');
  if (descriptor === String) {
    return {
      expected: 'string',
      target: 'string',
      materialize: (input) => input,
      validateStructure(input, path, violations, validationContext) {
        if (!visitStructuralValue(path, violations, validationContext)) return;
        if (typeof input !== 'string') invalidType(path, 'string', violations);
      },
      validateFields() {},
      validateRoots() {},
      resolvesInputPath: (_input, path) => path.length === 0,
    };
  }
  if (descriptor === Number) {
    return {
      expected: 'finite number',
      target: 'number',
      materialize: (input) => input,
      validateStructure(input, path, violations, validationContext) {
        if (!visitStructuralValue(path, violations, validationContext)) return;
        if (typeof input !== 'number' || !Number.isFinite(input)) {
          invalidType(path, 'finite number', violations);
        }
      },
      validateFields() {},
      validateRoots() {},
      resolvesInputPath: (_input, path) => path.length === 0,
    };
  }
  if (descriptor === Boolean) {
    return {
      expected: 'boolean',
      target: 'boolean',
      materialize: (input) => input,
      validateStructure(input, path, violations, validationContext) {
        if (!visitStructuralValue(path, violations, validationContext)) return;
        if (typeof input !== 'boolean') invalidType(path, 'boolean', violations);
      },
      validateFields() {},
      validateRoots() {},
      resolvesInputPath: (_input, path) => path.length === 0,
    };
  }
  if (descriptor === null) {
    return {
      expected: 'null',
      target: 'null',
      materialize: (input) => input,
      validateStructure(input, path, violations, validationContext) {
        if (!visitStructuralValue(path, violations, validationContext)) return;
        if (input !== null) invalidType(path, 'null', violations);
      },
      validateFields() {},
      validateRoots() {},
      resolvesInputPath: (_input, path) => path.length === 0,
    };
  }
  if (Array.isArray(descriptor)) {
    const elements = snapshotMetadataArray(
      descriptor,
      1,
      'HTTP route JSON body array descriptor is invalid',
    );
    if (elements.length !== 1) invalidContract('HTTP route JSON body array descriptor is invalid');
    const element = compileDescriptor(elements[0], context, depth + 1);
    return {
      expected: 'array',
      target: 'array',
      contract: element.contract,
      materialize: (input) => (input as unknown[]).map(element.materialize),
      validateStructure(input, path, violations, validationContext) {
        if (!visitStructuralValue(path, violations, validationContext)) return;
        if (!Array.isArray(input)) {
          invalidType(path, 'array', violations);
          return;
        }
        for (let index = 0; index < input.length; index += 1) {
          element.validateStructure(input[index], [...path, index], violations, validationContext);
          if (validationContext.maxValuesExceeded) break;
        }
      },
      validateFields(input, path, violations) {
        (input as unknown[]).forEach((value, index) =>
          element.validateFields(value, [...path, index], violations),
        );
      },
      validateRoots(input, path, violations) {
        (input as unknown[]).forEach((value, index) =>
          element.validateRoots(value, [...path, index], violations),
        );
      },
      resolvesInputPath(input, path) {
        if (path.length === 0) return true;
        const [segment, ...remaining] = path;
        return (
          Array.isArray(input) &&
          typeof segment === 'number' &&
          segment < input.length &&
          element.resolvesInputPath(input[segment], remaining)
        );
      },
    };
  }
  const resolver =
    descriptor !== null && typeof descriptor === 'object'
      ? BODY_CLASS_RESOLVERS.get(descriptor)
      : undefined;
  if (resolver && utilTypes.isProxy(resolver)) {
    invalidContract('HTTP route JSON body class resolver is invalid');
  }
  let BodyClass: HttpRouteJsonBodyClass;
  try {
    if (resolver) {
      const cachedResolution = context.resolvedClasses.get(descriptor as object);
      BodyClass = cachedResolution ?? resolver.call(undefined);
      if (!cachedResolution) context.resolvedClasses.set(descriptor as object, BodyClass);
    } else {
      BodyClass = descriptor as HttpRouteJsonBodyClass;
    }
  } catch (cause) {
    invalidContract('HTTP route JSON body class resolver failed', cause);
  }
  const contract = compileClass(BodyClass, context);
  return {
    expected: 'object',
    target: 'object',
    contract,
    materialize: contract.materializeValue,
    validateStructure: contract.validateStructure,
    validateFields: contract.validateFields,
    validateRoots: contract.validateRoots,
    resolvesInputPath: contract.resolvesInputPath,
  };
}

/**
 * Compiles immutable execution data for a route body class.
 * Компилирует неизменяемые данные выполнения для класса тела маршрута.
 * @param BodyClass Declared application class. / Объявленный прикладной класс.
 * @returns Compiled contract. / Скомпилированный контракт.
 * @private
 */
export function compileHttpRouteJsonBodyContract<Body extends object>(
  BodyClass: HttpRouteJsonBodyClass<Body>,
  contracts: Map<Function, CompiledHttpRouteJsonBodyContract> = new Map(),
): CompiledHttpRouteJsonBodyContract<Body> {
  return compileClass(BodyClass, {
    contracts,
    classes: new Set(),
    resolvedClasses: new WeakMap(),
    fieldCount: 0,
    validatorReferences: 0,
  });
}

/**
 * Compiles one class within a possibly cyclic contract graph.
 * Компилирует один класс внутри потенциально циклического графа контрактов.
 * @param BodyClass Contract class. / Класс контракта.
 * @param contracts Plans already discovered in this graph. / Уже обнаруженные планы графа.
 * @returns Compiled class contract. / Скомпилированный контракт класса.
 * @private
 */
function compileClass<Body extends object>(
  BodyClass: HttpRouteJsonBodyClass<Body>,
  context: CompilationContext,
): CompiledHttpRouteJsonBodyContract<Body> {
  const cached = context.contracts.get(BodyClass);
  if (cached) {
    accountCompiledGraph(cached, context);
    return cached as CompiledHttpRouteJsonBodyContract<Body>;
  }
  if (
    typeof BodyClass !== 'function' ||
    utilTypes.isProxy(BodyClass) ||
    !BodyClass.prototype ||
    utilTypes.isProxy(BodyClass.prototype)
  ) {
    invalidContract('HTTP route JSON body class is invalid');
  }
  if (Object.getPrototypeOf(BodyClass.prototype) !== Object.prototype) {
    throw new InvalidHttpRouteJsonBodyContractError(
      `HTTP route JSON body contract ${BodyClass.name} must not inherit another class`,
    );
  }
  const schemaDescriptor = Object.getOwnPropertyDescriptor(BodyClass, 'schema');
  if (
    !schemaDescriptor ||
    !('value' in schemaDescriptor) ||
    schemaDescriptor.value === null ||
    typeof schemaDescriptor.value !== 'object' ||
    Array.isArray(schemaDescriptor.value)
  ) {
    throw new InvalidHttpRouteJsonBodyContractError(
      `HTTP route JSON body contract ${BodyClass.name} has an invalid static schema`,
    );
  }
  const schema = schemaDescriptor.value as object;
  if (
    utilTypes.isProxy(schema) ||
    (Object.getPrototypeOf(schema) !== Object.prototype && Object.getPrototypeOf(schema) !== null)
  ) {
    invalidContract(`HTTP route JSON body contract ${BodyClass.name} has an invalid static schema`);
  }
  const schemaKeys = Reflect.ownKeys(schema);
  const validatorsDescriptor = Object.getOwnPropertyDescriptor(BodyClass, 'validators');
  if (
    validatorsDescriptor &&
    (!('value' in validatorsDescriptor) || validatorsDescriptor.value === undefined)
  ) {
    invalidContract(`HTTP route JSON body contract ${BodyClass.name} has invalid validators`);
  }
  const declaredRootValidators = validatorsDescriptor?.value;
  const rootValidators = (
    declaredRootValidators === undefined
      ? []
      : snapshotMetadataArray(
          declaredRootValidators,
          32,
          `HTTP route JSON body contract ${BodyClass.name} has invalid validators`,
        )
  ) as HttpRouteJsonBodyRootValidator<Body>[];
  if (
    rootValidators.some(
      (validator: unknown) => typeof validator !== 'function' || utilTypes.isProxy(validator),
    )
  ) {
    invalidContract(`HTTP route JSON body contract ${BodyClass.name} has invalid validators`);
  }
  accountClass(context, BodyClass, schemaKeys.length, rootValidators.length);
  let fields: {
    name: string;
    nullable: boolean;
    descriptor: CompiledDescriptor;
    validators: HttpRouteJsonBodyFieldValidator<unknown>[];
  }[] = [];
  let fieldNames = new Set<string>();
  const contract: CompiledHttpRouteJsonBodyContract<Body> = {
    materialize(input: unknown): Body {
      const violations: HttpRouteJsonBodyViolation[] = [];
      freezeJson(input);
      contract.validateStructure(input, [], violations, { values: 0, maxValuesExceeded: false });
      if (violations.length === 0) contract.validateFields(input, [], violations);
      if (violations.length === 0) contract.validateRoots(input, [], violations);
      if (violations.length > 100) {
        violations.splice(99, violations.length - 99, {
          path: '',
          code: 'TOO_MANY_VIOLATIONS',
          message: 'Additional violations omitted',
        });
      }
      if (violations.length > 0) throw new HttpRouteJsonBodyValidationError(violations);
      return contract.materializeValue(input);
    },
    materializeValue(input: unknown): Body {
      const source = input as Record<string, unknown>;
      const values = fields.map((field) =>
        Object.hasOwn(source, field.name)
          ? field.descriptor.materialize(source[field.name])
          : undefined,
      );
      let instance: Body;
      try {
        instance = new BodyClass();
      } catch (cause) {
        throw new TypeError('HTTP route JSON body constructor threw', { cause });
      }
      if (Object.getPrototypeOf(instance) !== BodyClass.prototype) {
        throw new TypeError('HTTP route JSON body constructor returned an invalid object');
      }
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        const existing = Object.getOwnPropertyDescriptor(instance, field.name);
        if (
          existing &&
          (!('value' in existing) || existing.writable !== true || existing.configurable !== true)
        ) {
          throw new TypeError('HTTP route JSON body field cannot be hydrated');
        }
        const hydrated = Reflect.defineProperty(
          instance,
          field.name,
          existing
            ? { ...existing, value: values[index] }
            : {
                value: values[index],
                enumerable: true,
                writable: true,
                configurable: true,
              },
        );
        if (!hydrated) throw new TypeError('HTTP route JSON body field cannot be hydrated');
      }
      return instance;
    },
    validateStructure(input, path, violations, validationContext): void {
      if (!visitStructuralValue(path, violations, validationContext)) return;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        invalidType(path, 'object', violations);
        return;
      }
      const source = input as Record<string, unknown>;
      for (const field of fields) {
        if (!Object.hasOwn(source, field.name)) continue;
        const value = source[field.name];
        if (value === null) {
          const fieldPath = [...path, field.name];
          if (!visitStructuralValue(fieldPath, violations, validationContext)) return;
          if (!field.nullable && field.descriptor.expected !== 'null') {
            violations.push({
              path: pointer(fieldPath),
              code: 'NULL_NOT_ALLOWED',
              message: 'Must not be null',
            });
          }
          continue;
        }
        field.descriptor.validateStructure(
          value,
          [...path, field.name],
          violations,
          validationContext,
        );
        if (validationContext.maxValuesExceeded) return;
      }
      for (const name of Object.keys(source)) {
        if (!fieldNames.has(name)) {
          if (!visitStructuralValue([...path, name], violations, validationContext)) return;
          violations.push({
            path: pointer([...path, name]),
            code: 'UNKNOWN_FIELD',
            message: 'Unknown field',
          });
        }
      }
    },
    validateFields(input, path, violations): void {
      const source = input as Record<string, unknown>;
      for (const field of fields) {
        const fieldPath = [...path, field.name];
        if (!Object.hasOwn(source, field.name)) {
          if (field.validators[0] && BUILT_IN_VALIDATORS.get(field.validators[0])?.required) {
            violations.push({ path: pointer(fieldPath), code: 'REQUIRED', message: 'Required' });
          }
          continue;
        }
        const value = source[field.name];
        if (value === null) continue;
        field.descriptor.validateFields(value, fieldPath, violations);
        const validationContext = Object.freeze({ path: Object.freeze(fieldPath) });
        for (const validator of field.validators) {
          const builtInMetadata = BUILT_IN_VALIDATORS.get(validator);
          if (builtInMetadata?.required) continue;
          let failure: HttpRouteJsonBodyValidatorFailure | undefined;
          try {
            failure = validator.call(undefined, value, validationContext);
          } catch (cause) {
            throw new TypeError('HTTP route JSON body field validator threw', { cause });
          }
          if (failure !== undefined) {
            if (!builtInMetadata) validateCustomFailure(failure, false);
            violations.push({
              path: pointer(fieldPath),
              code: failure.code,
              message: failure.message,
            });
          }
        }
      }
    },
    validateRoots(input, path, violations): void {
      const source = input as Record<string, unknown>;
      for (const field of fields) {
        if (!Object.hasOwn(source, field.name) || source[field.name] === null) continue;
        field.descriptor.validateRoots(source[field.name], [...path, field.name], violations);
      }
      for (const validator of rootValidators) {
        let result:
          | HttpRouteJsonBodyRootValidatorFailure
          | readonly HttpRouteJsonBodyRootValidatorFailure[]
          | undefined;
        try {
          result = validator.call(undefined, input as HttpRouteJsonBodyInput<Body>);
        } catch (cause) {
          throw new TypeError('HTTP route JSON body root validator threw', { cause });
        }
        if (result === undefined) continue;
        const failures = Array.isArray(result) ? result : [result];
        for (const failure of failures) {
          validateCustomFailure(failure, true);
          const relativePath = failure.path ?? [];
          if (!contract.resolvesInputPath(input, relativePath)) {
            throw new TypeError('HTTP route JSON body root validator returned an invalid path');
          }
          violations.push({
            path: pointer([...path, ...relativePath]),
            code: failure.code,
            message: failure.message,
          });
        }
      }
    },
    resolvesInputPath(input, path): boolean {
      if (path.length === 0) return true;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
      const [segment, ...remaining] = path;
      if (typeof segment !== 'string') return false;
      const field = fields.find((candidate) => candidate.name === segment);
      if (!field) return false;
      if (!Object.hasOwn(input, segment)) return remaining.length === 0;
      const value = (input as Record<string, unknown>)[segment];
      if (value === null) return remaining.length === 0;
      return field.descriptor.resolvesInputPath(value, remaining);
    },
  };
  context.contracts.set(BodyClass, contract);
  fields = schemaKeys.map((key) => {
    if (
      typeof key !== 'string' ||
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor'
    ) {
      invalidContract(`HTTP route JSON body contract ${BodyClass.name} has an invalid schema key`);
    }
    const property = Object.getOwnPropertyDescriptor(schema, key)!;
    if (!('value' in property)) {
      invalidContract(`HTTP route JSON body contract ${BodyClass.name} schema has an accessor`);
    }
    const entry = property.value;
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      utilTypes.isProxy(entry) ||
      (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)
    ) {
      invalidContract(`HTTP route JSON body contract ${BodyClass.name} has an invalid field`);
    }
    const entryKeys = Reflect.ownKeys(entry);
    if (
      !entryKeys.includes('type') ||
      entryKeys.some(
        (entryKey) =>
          typeof entryKey !== 'string' || !['type', 'nullable', 'validators'].includes(entryKey),
      )
    ) {
      invalidContract(`HTTP route JSON body contract ${BodyClass.name} has an invalid field`);
    }
    for (const entryKey of entryKeys) {
      if (!('value' in Object.getOwnPropertyDescriptor(entry, entryKey)!)) {
        invalidContract(`HTTP route JSON body contract ${BodyClass.name} field has an accessor`);
      }
    }
    const field = entry as {
      type: unknown;
      nullable?: true;
      validators?: readonly HttpRouteJsonBodyFieldValidator<unknown>[];
    };
    if (Object.hasOwn(field, 'nullable') && field.nullable !== true) {
      invalidContract(`HTTP route JSON body contract ${BodyClass.name} has invalid nullability`);
    }
    if (field.type === null && field.nullable === true) {
      invalidContract(`HTTP route JSON body contract ${BodyClass.name} has redundant nullability`);
    }
    const declaredFieldValidators = Object.hasOwn(field, 'validators')
      ? field.validators
      : undefined;
    if (Object.hasOwn(field, 'validators') && declaredFieldValidators === undefined) {
      invalidContract(
        `HTTP route JSON body contract ${BodyClass.name} has invalid field validators`,
      );
    }
    const validators = (
      declaredFieldValidators === undefined
        ? []
        : snapshotMetadataArray(
            declaredFieldValidators,
            32,
            `HTTP route JSON body contract ${BodyClass.name} has invalid field validators`,
          )
    ) as HttpRouteJsonBodyFieldValidator<unknown>[];
    if (
      validators.some(
        (validator) => typeof validator !== 'function' || utilTypes.isProxy(validator),
      )
    ) {
      invalidContract(
        `HTTP route JSON body contract ${BodyClass.name} has invalid field validators`,
      );
    }
    context.validatorReferences += validators.length;
    if (context.validatorReferences > 4096) {
      invalidContract('HTTP route JSON body contract graph exceeds 4096 validator references');
    }
    const requiredIndices = validators.flatMap((validator, index) =>
      BUILT_IN_VALIDATORS.get(validator)?.required ? [index] : [],
    );
    if (requiredIndices.length > 1 || requiredIndices.some((index) => index !== 0)) {
      invalidContract(`HTTP route JSON body contract ${BodyClass.name} has invalid required()`);
    }
    const compiledDescriptor = compileDescriptor(field.type, context);
    for (const validator of validators) {
      const metadata = BUILT_IN_VALIDATORS.get(validator);
      if (
        metadata &&
        metadata.target !== 'any' &&
        !(
          (metadata.target === 'number' && compiledDescriptor.target === 'number') ||
          (metadata.target === 'length' &&
            (compiledDescriptor.target === 'string' || compiledDescriptor.target === 'array'))
        )
      ) {
        invalidContract(
          `HTTP route JSON body contract ${BodyClass.name} has a validator for an invalid target`,
        );
      }
    }
    return {
      name: key,
      nullable: field.nullable === true,
      descriptor: compiledDescriptor,
      validators,
    };
  });
  fieldNames = new Set(fields.map((field) => field.name));
  COMPILED_CONTRACT_METADATA.set(contract, {
    BodyClass,
    fieldCount: fields.length,
    validatorReferences:
      rootValidators.length + fields.reduce((total, field) => total + field.validators.length, 0),
    dependencies: fields.flatMap((field) =>
      field.descriptor.contract ? [field.descriptor.contract] : [],
    ),
  });
  return Object.freeze(contract);
}
