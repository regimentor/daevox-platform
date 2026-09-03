---
status: accepted
---

# Классовый контракт JSON-тела HTTP-маршрута

HTTP-маршрут может объявить прикладной класс как `body`. Собственная `static schema` класса является
исчерпывающим runtime-источником допустимых JSON keys и компилируется атомарно при регистрации.
Schema поддерживает строгие primitive descriptors, `null`, вложенные contract classes,
одноэлементные array descriptors и отложенные `bodyClass()` references. Наследование contract
classes и произвольные object descriptors не поддерживаются.

Contract применяется лениво первым `ctx.requestBody.json()`. Выполнение разделено на structure,
field validators, bottom-up root validators и materialization; constructors запускаются только
после полного успеха validation. Проверенный JSON-граф замораживается, а созданные class instances
и arrays остаются изменяемыми и принадлежат приложению. Route middleware и handler разделяют один
request-local success/failure cache.

Нарушения input представлены `HttpRouteJsonBodyValidationError` и безопасным HTTP `400` с RFC 6901
paths. Неверные schema/declaration metadata представлены `InvalidHttpRouteJsonBodyContractError`
при регистрации. Exceptions и malformed результаты application validators, constructors и
property hydration являются application bugs, наблюдаются через `http.onError` и дают `500`.

Registration сохраняет immutable compiled plan и закрепляет первый успешно опубликованный plan
constructor в пределах одного `Application`. Fixed registration/request limits ограничивают
сложность contract graph и входного JSON; эти пределы не конфигурируются в первой версии.
