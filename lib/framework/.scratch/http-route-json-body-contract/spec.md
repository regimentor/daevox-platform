# Контракт JSON-тела HTTP-маршрута

## Статус и назначение

Спецификация implementation-ready. Она определяет публичный interface и поведение
`HttpRouteJsonBodyContract` в `@daevox/framework`, но сама инициатива не изменяет production-код.

HTTP-маршрут может объявить прикладной класс как `body: UserDto`. Первый вызов
`ctx.requestBody.json()` лениво проверяет JSON-представление тела HTTP-запроса и при успехе возвращает
экземпляр этого класса. Route middleware и HTTP-обработчик разделяют один request-local cache.

Корнем contract первой версии является только JSON object. JSON primitives, `null`, arrays и
вложенные objects поддерживаются как рекурсивные значения полей. Top-level contracts других форм не
поддерживаются.

## Цельный usage

```ts
import {
  Application,
  bodyClass,
  HttpControllerBase,
  integer,
  min,
  minLength,
  required,
  type HttpMiddleware,
  type HttpRequestContext,
  type HttpRouteJsonBodyRootValidator,
  type HttpRouteJsonBodySchema,
} from '@daevox/framework';

class AddressDto {
  street!: string;
  apartment!: number | null;

  static schema = {
    street: { type: String, validators: [required(), minLength(1)] },
    apartment: { type: Number, nullable: true, validators: [min(1), integer()] },
  } as const satisfies HttpRouteJsonBodySchema<AddressDto>;
}

const validUser: HttpRouteJsonBodyRootValidator<UserDto> = (user) =>
  user.active || user.aliases.length === 0
    ? undefined
    : {
        path: ['aliases'],
        code: 'INACTIVE_ALIASES',
        message: 'Inactive user cannot have aliases',
      };

class UserDto {
  email!: string;
  active!: boolean;
  address!: AddressDto;
  aliases!: string[];
  displayName?: string | null;

  static schema = {
    email: { type: String, validators: [required(), minLength(3)] },
    active: { type: Boolean, validators: [required()] },
    address: { type: AddressDto, validators: [required()] },
    aliases: { type: [String], validators: [required(), minLength(1)] },
    displayName: { type: String, nullable: true, validators: [minLength(1)] },
  } as const satisfies HttpRouteJsonBodySchema<UserDto>;

  static validators = [validUser] as const;
}

class TreeNodeDto {
  children!: TreeNodeDto[];

  static schema = {
    children: {
      type: [bodyClass(() => TreeNodeDto)],
      validators: [required()],
    },
  } as const satisfies HttpRouteJsonBodySchema<TreeNodeDto>;
}

class AppState {
  audit(_email: string) {}
}

const auditBody: HttpMiddleware<AppState, UserDto> = async (appState, ctx, next) => {
  const body = await ctx.requestBody.json();
  appState.audit(body.email);
  return next();
};

class UsersController extends HttpControllerBase {
  static prefix = '/users';
  static routes = [
    {
      method: 'POST',
      path: '/',
      handler: 'create',
      body: UserDto,
      middleware: [auditBody],
    },
  ] as const;

  async create(appState: AppState, ctx: HttpRequestContext<UserDto>) {
    const body = await ctx.requestBody.json();
    appState.audit(body.email);
    return { status: 201, body: { street: body.address.street } };
  }
}

new Application({ appState: AppState }).registerHttpController(UsersController);
```

## Public interface

### Новые exports

Runtime exports:

- `bodyClass()`;
- `required()`, `minLength()`, `maxLength()`, `min()`, `max()`, `integer()`;
- `HttpRouteJsonBodyValidationError`;
- `InvalidHttpRouteJsonBodyContractError`.

Type exports:

- `HttpRouteJsonBodyClass<T>`;
- `HttpRouteJsonBodySchema<T>`;
- `HttpRouteJsonBodyInput<T>`;
- `HttpRouteJsonBodyFieldValidator<T>`;
- `HttpRouteJsonBodyRootValidator<T>`;
- `HttpRouteJsonBodyValidationContext`;
- `HttpRouteJsonBodyValidatorFailure`;
- `HttpRouteJsonBodyViolation`;
- `HttpRouteJsonBodyFrameworkViolationCode`.

Opaque class-reference descriptor, возвращаемый `bodyClass()`, не создаётся пользователем вручную и
не требует отдельного именованного export.

### Existing generics

```ts
interface HttpRequestBodyReader<JsonBody = unknown> {
  readonly used: boolean;
  json(): Promise<JsonBody>;
  text(): Promise<string>;
  bytes(): Promise<Buffer>;
  formData(): Promise<FormData>;
}

interface HttpRequestContext<JsonBody = unknown, State extends object = Record<string, unknown>> {
  readonly requestBody: HttpRequestBodyReader<JsonBody>;
}

type HttpHandler<
  AppState extends object = AppStateInstance,
  JsonBody = unknown,
  State extends object = Record<string, unknown>,
> = (
  appState: AppState,
  context: HttpRequestContext<JsonBody, State>,
) => HttpResponse | Promise<HttpResponse>;

type HttpMiddleware<
  AppState extends object = AppStateInstance,
  JsonBody = unknown,
  State extends object = Record<string, unknown>,
> = (
  appState: AppState,
  context: HttpRequestContext<JsonBody, State>,
  next: () => Promise<HttpResponse>,
) => HttpResponse | Promise<HttpResponse>;

interface HttpRouteDeclaration<
  AppState extends object = AppStateInstance,
  JsonBody = unknown,
  State extends object = Record<string, unknown>,
> {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly body?: HttpRouteJsonBodyClass<JsonBody>;
  readonly middleware?: readonly HttpMiddleware<AppState, JsonBody, State>[];
}
```

`body: UserDto` специализирует JSON-type route middleware и именованного handler. Registration proof
проверяет assignability для каждой declaration: `unknown` и безопасный union разрешены, более узкий
или посторонний тип запрещён. Application/controller-wide middleware по умолчанию видит `unknown`.

Authoring сохраняет `static routes = [...] as const`, явную аннотацию handler context и standalone
route middleware. Builder, decorator и generic controller base не вводятся. Startup и runtime
registration используют один `CheckedHttpController`. Widened handler, dynamic metadata и явный
`any` находятся за границей compile-time proof. `ctx.route` не получает body/schema metadata.

## Class и schema

Contract class:

- является constructable обычным class с public zero-argument TypeScript constructor;
- имеет собственную `static schema` data property;
- не наследует другой class и не является Proxy;
- может иметь собственную `static validators` data property;
- материализуется точным сохранённым constructor без subclass substitution.

`static schema` — plain object с prototype `Object.prototype` или `null`. Она является единственным
runtime-источником истины и исчерпывающим списком разрешённых JSON keys. Compile-time schema
описывает все public non-function properties класса и запрещает лишние keys. Methods исключаются.
Пустая schema `{}` принимает только пустой JSON object.

Field entry имеет точные own keys:

```ts
{
  type: Descriptor;
  nullable?: true;
  validators?: readonly HttpRouteJsonBodyFieldValidator<unknown>[];
}
```

Явный `undefined`, `nullable: false`, accessors, symbols и дополнительные keys запрещены. Empty
validator arrays допустимы. Schema keys `__proto__`, `prototype`, `constructor` запрещены; прочие
строки, включая empty и Unicode, допустимы.

Поддерживаемые descriptors:

- `String`: любая JSON string;
- `Number`: finite number, без coercion;
- `Boolean`: boolean;
- `null`: только JSON `null`;
- прямой contract class;
- `bodyClass(() => ContractClass)` для self/forward references;
- точный dense одноэлементный `[Descriptor]` для массива любой длины, включая пустой.

`nullable: true` ортогонально разрешает `null` обычному descriptor; с descriptor `null` оно
запрещено. Отсутствие key разрешено без `required()`, а materialized field получает `undefined`.
Присутствующий `null` отсутствием не считается.

TypeScript property поддерживает только точный широкий `string`, `number`, `boolean`, `null`,
contract class либо mutable/readonly homogeneous array, с добавлением `null`/`undefined`.
Literal/heterogeneous unions, tuples, enums, branded primitives, records и произвольные interfaces
не поддерживаются.

`bodyClass()` resolver вызывается один раз при compilation и обязан вернуть exact valid class.
Self/mutual cyclic schema graphs разрешены; повторный constructor завершает обход известной ветки.
Конкретное JSON-значение остаётся конечным деревом.

## Registration и compiled plan

`InvalidHttpRouteJsonBodyContractError extends InvalidHttpRouteError` синхронно представляет
неверный declaration/contract. Его developer-facing message содержит method/path, root class name и
metadata path; текст нестабилен. Resolver exception сохраняется как `cause`.

Одна registration transaction полностью проверяет/компилирует controller до публикации router,
middleware и plans. Failure не меняет состояние framework. Resolver side effects откатить нельзя;
resolver считается trusted pure application code.

Proxy запрещены для classes/prototypes, resolvers/results, schemas, fields, descriptor/validator
arrays и custom validators. Metadata читаются own property descriptors; getters не вызываются.
Constructor при registration не запускается, а неоднозначный `Function.length` не проверяется.

Schema/descriptors/arrays глубоко копируются в frozen null-prototype plan. После публикации их
мутация не влияет на route. Function/constructor identity сохраняется. Первый успешно
опубликованный plan constructor закрепляется в одном `Application`; следующие routes используют его.
Failed compilation ничего не закрепляет; разные `Application` независимы.

Fixed limits одного root contract:

- 128 уникальных classes;
- 1 024 schema fields;
- descriptor depth 32;
- 32 validators на field/root target;
- 4 096 validator references.

Превышение и все статически обнаружимые class/schema/descriptor/validator нарушения дают
registration error. Custom callback output, constructor behavior и request shape проверяются на
ingress.

## Validation

После JSON parsing structural phase обходит request graph согласно compiled plan, проверяет root
object, descriptors, keys, presence, nullability и fixed request limits. Граф, созданный
`JSON.parse`, затем глубоко замораживается in-place без дополнительной plain-object копии.
Validation/freezing/materialization не зависят от рекурсивного JavaScript call stack.

`HttpRouteJsonBodyInput<T>` является глубокой readonly JSON-проекцией public data fields `T` без
методов/class identity. Field validator получает корректное present/non-null value и frozen context
с абсолютными path segments. Root validator получает projection всего class subtree и может вернуть
одну либо несколько violations с относительными segments.

Validation phases:

1. structure всего дерева;
2. при structural success — field validators depth-first;
3. при отсутствии field violations — class root validators bottom-up, root contract последним;
4. при полном успехе — materialization.

Все validators фазы выполняются в declaration order и агрегируют violations. Structural failure
ветки не вызывает её validators. Root validators не выполняются после field failures. Validator
throw, thenable/Promise или malformed result немедленно прекращает operation, отбрасывает client
violations и становится application bug `500`.

`required()` — special presence-validator, разрешён один раз и только первым. Missing optional field
пропускает остальные validators. Missing required field даёт `REQUIRED`; `required()` на descriptor
`null` требует присутствующий key со значением `null`.

Built-in validators:

| Validator      | Target       | Code         | Message                                 |
| -------------- | ------------ | ------------ | --------------------------------------- |
| `required()`   | любое поле   | `REQUIRED`   | `Required`                              |
| `minLength(n)` | string/array | `MIN_LENGTH` | `Must have length at least ${n}`        |
| `maxLength(n)` | string/array | `MAX_LENGTH` | `Must have length at most ${n}`         |
| `min(n)`       | number       | `MIN`        | `Must be greater than or equal to ${n}` |
| `max(n)`       | number       | `MAX`        | `Must be less than or equal to ${n}`    |
| `integer()`    | number       | `INTEGER`    | `Must be an integer`                    |

String length измеряется Unicode code points, array length — elements. Length bounds являются
non-negative integers, numeric bounds finite; `-0` нормализуется в `0`, messages используют
`String(n)`. Built-in messages не настраиваются. Object size validator отсутствует.

Validators вызываются с `this === undefined`, context/path frozen. Callable identity переиспользуется
между routes/requests; mutable closure state, I/O и side effects являются application
responsibility. Async validators не поддерживаются и sandbox/timeout отсутствует.

Custom field validator возвращает zero/one `{ code, message }`; root validator — zero/one/array и
optional relative path. Code соответствует `^[A-Z][A-Z0-9_]*$`, имеет 1–64 ASCII chars и не
совпадает с reserved code. Message имеет 1–512 Unicode code points без trimming. Root path обязан
разрешаться schema; absent optional target допустим, переход глубже через absent/null — нет, array
index обязан существовать. Invalid result/path даёт `500`.

Fixed request limits: depth 64, 100 000 посещённых JSON values, 100 violations. `MAX_DEPTH`
пропускает слишком глубокий subtree и продолжает siblings; `MAX_VALUES` добавляется на первом value
сверх global budget и прекращает обход. При переполнении violations сохраняются первые 99 и
добавляется root `TOO_MANY_VIOLATIONS`.

## Materialization и ownership

Materialization запускается только после всех validators и идёт bottom-up в schema/array order;
root создаётся последним. Каждый object создаёт новый exact class instance, каждый array — новый
обычный mutable `Array`; узлы не дедуплицируются.

Constructor вызывается синхронно без аргументов ровно один раз на object. Результат должен иметь
`Object.getPrototypeOf(result) === BodyClass.prototype`. Framework не гарантирует обнаружение
экзотического явно возвращённого объекта с вручную подделанным prototype.

Каждый schema key записывается own data property без setters:

- existing own writable configurable data property получает value;
- missing property создаётся enumerable/writable/configurable;
- accessor, non-writable/non-configurable descriptor и невозможность добавить property дают `500`;
- missing optional field записывается как `undefined`, перезаписывая constructor default;
- constructor-created fields вне schema сохраняются;
- TypeScript `readonly` не мешает hydration.

Instances/arrays не замораживаются и принадлежат приложению; их можно сохранить после запроса.
Framework не публикует partial graph через cache/handler, но application constructor способен
самостоятельно раскрыть `this`. Constructor/prototype/assignment failure является application bug
`500`, а не client violation.

## Reader и middleware lifecycle

Для route с contract `requestBody.json()` имеет request-local state:

| State                            | Operation                  | Result                                          |
| -------------------------------- | -------------------------- | ----------------------------------------------- |
| unused                           | первый `json()`            | `used = true`, создать contract operation/cache |
| contract pending/success/failure | следующий `json()`         | присоединиться к тому же outcome                |
| unused                           | первая иная representation | потребить обычный one-shot reader               |
| consumed by other representation | `json()`                   | rejected `TypeError`                            |
| contract started                 | иная representation        | rejected `TypeError`                            |

Success возвращает один root instance, failure — один error object; Promise identity не обещается.
Без `body` reader сохраняет strict one-shot semantics. Raw JSON на contract route не выдаётся.
Public methods никогда не бросают синхронно: все failures являются rejected Promise.

Contract полностью lazy. Short-circuit без `json()` не запускает parsing/validation/constructors.
Любой middleware level может начать operation; application/controller middleware видит outcome как
`unknown`, route middleware/handler — как body type. Controller instance создаётся только при
достижении handler.

Middleware может catch failure собственного `json()` или `next()`. После catch следующий `json()`
получит cached failure; fallback representation отсутствует. Uncaught expected body/validation
errors становятся safe `400`/`415`; reader/validator/constructor bugs — `500` с одним итоговым
`http.onError`.

Если signal уже aborted при первом `json()`, cache получает стандартный `AbortError`, не запуская
operation. Начавшийся synchronous traversal не имеет artificial async checkpoints; поздний abort не
инвалидирует success. Cache принадлежит одному reader/request и живёт по обычным GC references;
между запросами разделяется только compiled plan.

## Validation errors

```ts
type HttpRequestBodyErrorCode = 'MALFORMED_BODY' | 'UNSUPPORTED_MEDIA_TYPE' | 'INVALID_JSON_BODY';

interface HttpRouteJsonBodyViolation {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

class HttpRouteJsonBodyValidationError extends HttpRequestBodyError {
  readonly code: 'INVALID_JSON_BODY';
  readonly status: 400;
  readonly violations: readonly HttpRouteJsonBodyViolation[];
}
```

Constructor принимает non-empty valid violations, defensively копирует/замораживает их и иначе
бросает `TypeError`. Application может создать/throw error. Default `Error.message` нестабилен;
stable properties — code/status/violations.

Paths кодируются RFC 6901 JSON Pointer: root `""`, `/` separator, `~` → `~0`, `/` → `~1`, array
indices decimal, empty key `"/"`.

Reserved structural codes/messages:

- `INVALID_TYPE`: `Expected string|finite number|boolean|null|array|object`;
- `NULL_NOT_ALLOWED`: `Must not be null`;
- `UNKNOWN_FIELD`: `Unknown field`;
- `MAX_DEPTH`: `Maximum JSON depth exceeded`;
- `MAX_VALUES`: `Maximum JSON value count exceeded`;
- `TOO_MANY_VIOLATIONS`: `Additional violations omitted`;
- все built-in validator codes/messages.

Structural invalidity прекращает только текущий subtree, кроме global `MAX_VALUES`. Ordering:
schema fields depth-first, arrays ascending, затем unknown keys в `Object.keys()` order; field
validators сохраняют traversal/declaration order, root validators — bottom-up/return order.
Duplicates сохраняются.

Uncaught error автоматически возвращает:

```json
{
  "error": "Bad Request",
  "code": "INVALID_JSON_BODY",
  "violations": [{ "path": "/email", "code": "REQUIRED", "message": "Required" }]
}
```

Response не содержит cause/stack/input/schema details. Framework messages стабильны и остаются
английскими. Localization выполняется middleware по code/path; custom messages принадлежат
приложению.

## Acceptance evidence

Implementation добавляет основной public seam-test
`test/unit/http-route-json-body-contract.test.ts` и расширяет:

- `controller-static-types.test.ts` — positive/negative generic proof;
- `application.test.ts` — startup/runtime atomic registration;
- `http-transport.test.ts` — middleware lifecycle и automatic responses;
- fuzz/stress/soak/mutation/benchmark harnesses — malformed, concurrency, memory, sensitivity и
  новый `http-json-contract` benchmark profile/baseline;
- `examples/http-json-body-contract/` — runnable black-box usage.

Матрица обязана покрыть все descriptors, nested/recursive/cyclic schemas, inheritance rejection,
schema mutations/limits, validators/order/errors, materialization/properties/constructors,
JSON Pointer/ordering/caps, lazy/repeated/parallel reader operations, cancellation, runtime
registration, pollution/proxy/getter cases и safe suppression. Production behavior проверяется
через public entrypoint; internal tests допустимы только для недоступного compiled-plan machinery.

Документация реализации: `README.md`, bilingual JSDoc, regenerated `docs/API.md`/`docs/api/*`,
`docs/interface/http.md`, `middleware.md`, `errors.md`, `docs/system-testing.md`, glossary, новый ADR
контракта и пересмотр ADR 0009.

Обязательные gates из корня:

```sh
npm run docs:build --workspace @daevox/framework
npm run verify
npm run fuzz:full --workspace @daevox/framework -- --seed <recorded-seed>
npm run stress --workspace @daevox/framework
npm run benchmark:full --workspace @daevox/framework
npm run soak:scheduled --workspace @daevox/framework
npm run mutation:changed --workspace @daevox/framework
```

Unavailable full benchmark/soak явно передаются как незавершённая acceptance и не заменяются smoke.

## Out of scope

- top-level scalar/array/null contracts;
- response, WebSocket и application-event body contracts;
- text/bytes/form/multipart validation;
- coercion, defaults, transforms и custom decoders;
- arbitrary object/record descriptors, unions, literals, enums и tuples;
- async/I/O validators, sandbox и callback timeout;
- localization внутри framework;
- configurable schema/request complexity limits.
