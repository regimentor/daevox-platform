Status: resolved
Type: grilling
Blocked by: 01, 02

# Связать body metadata с TypeScript-типом HTTP-обработчика

## Question

Как `body: UserDto` в `HttpRouteDeclaration` статически связывает конкретный HTTP-маршрут с типом тела
его HTTP-обработчика и route middleware, сохраняя literal handler proof, `as const`, application/controller-wide middleware и
runtime-регистрацию? Определить public exports, generic defaults, форму доступа к материализованному значению и
границу compile-time proof для динамических declarations.

## Answer

Public generics используют единый порядок и безопасные defaults:

```ts
interface HttpRequestBodyReader<JsonBody = unknown> {}
interface HttpRequestContext<JsonBody = unknown, State extends object = Record<string, unknown>> {}

type HttpHandler<
  AppState extends object = AppStateInstance,
  JsonBody = unknown,
  State extends object = Record<string, unknown>,
> = unknown;

type HttpMiddleware<
  AppState extends object = AppStateInstance,
  JsonBody = unknown,
  State extends object = Record<string, unknown>,
> = unknown;

interface HttpRouteDeclaration<
  AppState extends object = AppStateInstance,
  JsonBody = unknown,
  State extends object = Record<string, unknown>,
> {}
```

`body: UserDto` связывает конкретную literal route declaration с
`HttpRequestContext<UserDto, State>` её именованного HTTP-обработчика и
`HttpMiddleware<AppState, UserDto, State>` route middleware. Материализованное значение доступно
через единственную JSON-точку `await ctx.requestBody.json(): Promise<UserDto>`. Без `body` default
остаётся `unknown`. `text()`, `bytes()` и `formData()` остаются доступны; их lifecycle-конкуренция
решается отдельно.

Application- и controller-wide middleware обслуживают разные HTTP-маршруты и поэтому по умолчанию
видят `JsonBody = unknown`. Authoring model сохраняет `static routes = [...] as const`, явную
аннотацию context handler и отдельную аннотацию route middleware; builder, decorator и generic base
controller не вводятся.

Registration proof проверяет безопасную assignability для каждой route declaration, а не точное
равенство. Handler или middleware, принимающий `unknown` либо подходящий union нескольких body
классов, допустим; принимающий более узкий или посторонний body type — нет. Один handler тем самым
может безопасно обслуживать несколько contracts.

`registerHttpController()` и `registerRuntimeHttpController()` используют один
`CheckedHttpController`: проверяются literal handler, handler/context/result, route middleware и
структурно доступная часть class/schema contract. Widened `handler: string` не проходит proof;
динамические declarations требуют runtime-проверки, а явный `any` остаётся сознательным отключением
TypeScript proof. Отсутствие наследования, own `static schema`, точные runtime descriptors и
результат `bodyClass()` проверяются только runtime.

`satisfies HttpRouteJsonBodySchema<UserDto>` рекомендуется для локальных schema errors, но не
обязателен: registration generic повторяет доступную compile-time проверку. `ctx.route` сохраняет
только `{ method, path, handler }`; body constructor и compiled plan остаются внутренними metadata.

Новые public exports:

- types `HttpRouteJsonBodyClass`, `HttpRouteJsonBodySchema`, `HttpRouteJsonBodyInput`,
  `HttpRouteJsonBodyFieldValidator`, `HttpRouteJsonBodyRootValidator`,
  `HttpRouteJsonBodyValidationContext`, `HttpRouteJsonBodyValidatorFailure`;
- runtime helpers `bodyClass`, `required`, `minLength`, `maxLength`, `min`, `max`, `integer`;
- существующие `HttpRequestContext`, `HttpRequestBodyReader`, `HttpHandler`, `HttpMiddleware` и
  `HttpRouteDeclaration` получают согласованные generics.
