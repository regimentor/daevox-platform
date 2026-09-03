# PROTOTYPE: публичный interface контракта JSON-тела HTTP-маршрута

Этот throwaway-прототип проверяет только цельность public usage и достижимый compile-time proof.
Runtime-поведение, точные validator semantics, наследование, materialization и error model остаются
за следующими decision tickets.

Компилируемый первичный артефакт: [`public-contract.ts`](public-contract.ts).

## Verdict

HTTP-маршрут объявляет прикладной класс непосредственно как `body: UserDto`. Класс не наследуется
от framework base class и не использует decorators: он предоставляет public zero-argument
constructor, собственную `static schema` и, при необходимости, `static validators`.

```ts
class AddressDto {
  street!: string;
  apartment!: number | null;

  static schema = {
    street: { type: String, validators: [required(), minLength(1)] },
    apartment: { type: Number, nullable: true, validators: [min(1)] },
  } as const satisfies HttpRouteJsonBodySchema<AddressDto>;
}

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
}
```

Один field entry имеет единообразную форму `{ type, nullable?, validators? }`. `type` принимает
рекурсивный descriptor `String`, `Number`, `Boolean`, `null`, прикладной class либо одноэлементный
array descriptor. Такая форма не смешивает массив значений с массивом validators и оставляет
nullable отдельной ортогональной характеристикой descriptor.

Прототип сохраняет `required()` именно validator, как задано картой. Поэтому TypeScript проверяет
совместимость descriptor с объявленным полем и требует `nullable: true` для `T | null`, но не
пытается вывести обязательность TypeScript-поля из содержимого массива validators. Точная связь
отсутствия, `undefined` и `required()` должна быть решена в ticket 04.

## Цельный route usage

```ts
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
    return { status: 201, body: { street: body.address.street } };
  }
}
```

Для route с `body` существующий `requestBody.json()` является единственной точкой доступа к
материализованному экземпляру. Введение второго `validatedBody()`/`contract()` создало бы две
конкурирующие JSON-операции, а возврат синхронного `ctx.body` отменил бы принятое удаление этого
свойства. Пример намеренно читает JSON и в route middleware, и в handler: public interface тем
самым требует общий success/failure cache; точная state machine будет решена в ticket 06.

Application- и controller-wide middleware по умолчанию сохраняют `JsonBody = unknown`, потому что
обслуживают несколько HTTP-маршрутов. Конкретный body type доступен route middleware через
`HttpMiddleware<AppState, UserDto>` и handler через `HttpRequestContext<UserDto>`.

## Compile-time proof

Прототип компилируется TypeScript 7 в strict/no-emit режиме и содержит негативные cases с
`@ts-expect-error`:

- descriptor не соответствует типу поля;
- в schema отсутствует data field класса;
- nullable-поле не объявляет `nullable: true`;
- тип context именованного handler не совпадает с `body` его декларации;
- route middleware ожидает другой класс тела.

Поля-функции экземпляра исключаются из `HttpRouteJsonBodySchema<T>`: schema описывает data fields,
а не методы прикладного класса. Негативные cases срабатывают в точке `satisfies` или регистрации
контроллера, сохраняя существующий literal-handler proof и необходимость `as const`.

Команда проверки из корня репозитория:

```sh
./node_modules/.bin/tsc --strict --noEmit --target esnext --module nodenext \
  --erasableSyntaxOnly --verbatimModuleSyntax \
  lib/framework/.scratch/http-route-json-body-contract/prototypes/public-contract.ts
```

## Кандидаты public exports

- `HttpRouteJsonBodyClass` и `HttpRouteJsonBodySchema` для связи class/schema;
- `HttpRouteJsonBodyValidator`, `HttpRouteJsonBodyValidationContext` и
  `HttpRouteJsonBodyViolation` для custom validators;
- `required()`, `minLength()` и `min()` как минимальные встроенные validators;
- существующие `HttpRouteDeclaration`, `HttpMiddleware`, `HttpHandler`, `HttpRequestContext` и
  `HttpRequestBodyReader` получают body-aware generic-связь без отдельного reader API.

Названия и точные сигнатуры validator context/return являются кандидатами, а не закрытым решением:
их фиксирует ticket 04. Точно так же прототип показывает минимальную форму `nullable`, массива и
class descriptor, но их runtime-инварианты, recursion и inheritance фиксирует ticket 02.
