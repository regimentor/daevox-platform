Status: resolved
Type: grilling
Blocked by: 03, 04, 06, 07

# Зафиксировать модель validation errors

## Question

Каковы публичный error class, стабильный code, HTTP status `400`, форма и порядок violations
`{ path, code, message }`, JSON Pointer escaping и агрегация type/required/custom failures? Определить catchability в middleware, связь с
`HttpRequestBodyError`, безопасное automatic response body, localization boundary и классификацию constructor/validator bugs как `500`, а не
клиентских violations.

## Answer

Публичный `HttpRouteJsonBodyValidationError extends HttpRequestBodyError` представляет только
валидный JSON, не удовлетворивший contract. Union `HttpRequestBodyErrorCode` расширяется
`INVALID_JSON_BODY`; error имеет стабильные `code = 'INVALID_JSON_BODY'`, `status = 400` и
`readonly violations`.

```ts
interface HttpRouteJsonBodyViolation {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}
```

Constructor принимает только непустой массив корректных violations, defensively копирует и
глубоко замораживает entries/array; неверный аргумент синхронно даёт `TypeError`. Приложение может
самостоятельно создать и бросить error. `Error.message` по умолчанию равен
`HTTP route JSON body validation failed`, но не является стабильным API; `cause` поддерживается и
никогда не сериализуется.

Неперехваченная ошибка автоматически даёт JSON `400`:

```json
{
  "error": "Bad Request",
  "code": "INVALID_JSON_BODY",
  "violations": [{ "path": "/address/street", "code": "REQUIRED", "message": "Required" }]
}
```

Stack, cause, class/schema/validator details и rejected input values не попадают в response.
Middleware может ловить broad `HttpRequestBodyError` либо конкретный validation error и полностью
заменять response, в том числе для локализации.

Violation path — RFC 6901 JSON Pointer: root `""`, slash separator, `~` → `~0`, `/` → `~1`, array
indices в decimal, empty property key `"/"`. Root validator path проверяется относительно schema
своего класса и получает внешний nested prefix. String segment обязан быть schema field, number —
существующим array index; absent optional field может быть target, но переход глубже через absent
или `null` запрещён. Invalid path является validator bug `500`.

Зарезервированные framework codes/messages:

- `INVALID_TYPE`: `Expected string`, `Expected finite number`, `Expected boolean`, `Expected null`,
  `Expected array` или `Expected object`;
- `NULL_NOT_ALLOWED`: `Must not be null`;
- `UNKNOWN_FIELD`: `Unknown field`;
- `MAX_DEPTH`: `Maximum JSON depth exceeded`;
- `MAX_VALUES`: `Maximum JSON value count exceeded`;
- `TOO_MANY_VIOLATIONS`: `Additional violations omitted`;
- `REQUIRED`, `MIN_LENGTH`, `MAX_LENGTH`, `MIN`, `MAX`, `INTEGER` и ранее определённые messages.

Custom code соответствует uppercase grammar, имеет длину 1–64 ASCII symbols, не совпадает с
reserved code; message содержит 1–512 Unicode code points без trimming. Нарушение является
malformed validator result `500`, а не поводом молча обрезать entry.

Порядок deterministic и не выполняет deduplication. Structural validation обходит известные поля в
schema order depth-first, arrays по индексам, затем unknown fields в `Object.keys()` order. Field
validators следуют тому же порядку и declaration order; root validators идут bottom-up, сохраняя
порядок возвращённых arrays.

`INVALID_TYPE`/`NULL_NOT_ALLOWED` прекращает только текущий subtree; absent required field и каждый
unknown field дают по одной violation. `MAX_DEPTH` пропускает слишком глубокий subtree, но оставляет
siblings; `MAX_VALUES` добавляется на первом значении сверх global budget и прекращает весь обход.
При общем переполнении сохраняются первые 99 entries и сотая root violation
`TOO_MANY_VIOLATIONS`.

Framework-owned messages и automatic `Bad Request` являются стабильными английскими строками;
встроенной localization нет. Основная machine-readable boundary — code/path.

Public exports дополняются `HttpRouteJsonBodyValidationError`, `HttpRouteJsonBodyViolation` и
`HttpRouteJsonBodyFrameworkViolationCode` — union всех reserved structural/built-in codes. Custom
codes остаются `string` с runtime validation.
