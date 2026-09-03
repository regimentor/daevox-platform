Status: resolved
Type: prototype

# Конкретизировать публичный interface контракта JSON-тела

## Question

Как выглядит цельный minimal public usage для `body: UserDto`, `static schema`, вложенных классов,
массивов, nullable-значений, validators, middleware и HTTP-обработчика? Создать дешёвый прототип
interface с compile-time examples и негативными usage cases, не реализуя runtime.

## Answer

Выбран route-first interface: прикладной класс передаётся как `body: UserDto`, описывает data fields
через собственную `static schema` и при необходимости root-level `static validators`. Field entry
имеет единую форму `{ type, nullable?, validators? }`; рекурсивный `type` принимает `String`,
`Number`, `Boolean`, `null`, прикладной класс либо одноэлементный array descriptor.

Материализованное значение остаётся доступно через существующий `await ctx.requestBody.json()`.
Для конкретного HTTP-маршрута `body` связывает его route middleware и именованный HTTP-обработчик с
`HttpRequestContext<UserDto>`; application- и controller-wide middleware по умолчанию видят
`unknown`. Это сохраняет один body reader и требует общего success/failure cache между route
middleware и handler, точная state machine которого определяется ticket 06.

Изолированный TypeScript-прототип доказывает позитивный usage с вложенным классом, массивом,
nullable/optional fields, field/root validators, middleware и handler. Негативные cases отклоняют
неверный descriptor, пропущенное поле schema, неверную nullability и несовпадение body-типа route с
handler или middleware. TypeScript намеренно не доказывает runtime-семантику `required()`.

Артефакты и рассмотренные границы: [описание interface](../prototypes/public-contract.md) и
[compile-time prototype](../prototypes/public-contract.ts).
