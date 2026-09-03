Status: resolved
Type: grilling
Blocked by: 02, 04, 05

# Определить registration-time проверки и safety-границы

## Question

Какие ошибки route metadata, class constructors, `static schema`, descriptors и validators framework отклоняет атомарно при
startup- и runtime-регистрации, а что может отказать только на ingress? Определить immutable snapshot metadata, пределы
глубины/числа полей и violations, cycle handling, prototype-pollution keys, getters/proxies, hostile validators и классы ошибок неверного
контракта отдельно от невалидного JSON-тела.

## Answer

Неверный declaration/contract отклоняется новым публичным
`InvalidHttpRouteJsonBodyContractError extends InvalidHttpRouteError`. Ошибка бросается синхронно
при startup- или runtime-registration и никогда не представляет request-specific invalid body.

Registration transaction сначала нормализует все routes, полностью компилирует reachable body
contracts и проверяет route conflicts; только после успеха одним шагом публикует router entries,
middleware и compiled plans. При failure собственное состояние framework не меняется. Внешние side
effects единственного намеренно вызываемого application callback — `bodyClass()` resolver —
откатить невозможно; resolver обязан быть pure.

Proxy запрещены для body classes и их prototypes, `bodyClass` resolvers/results, schema/field
objects, array descriptors, validator arrays и custom validators. Metadata читаются через own
property descriptors; accessors запрещены и не вызываются. Resolver вызывается ровно один раз за
compilation, а его exception сохраняется как `cause` contract error.

Contract class обязан быть constructable, иметь обычный non-Proxy prototype с
`Object.getPrototypeOf(BodyClass.prototype) === Object.prototype`, собственную `static schema` data
property и не иметь inheritance. Registration не вызывает constructor и не проверяет
`Function.length`: TypeScript доказывает `new () => T`, а фактический отказ вызова без аргументов
остаётся ingress application bug.

`static schema` — plain object с prototype `Object.prototype` или `null`, содержащий только
enumerable own string keys. Field entry — plain object с точными keys `type`, optional `nullable`,
optional `validators`; присутствующий `nullable` равен только `true`, а с descriptor `null`
запрещён. Validator arrays и одноэлементные array descriptors dense, не имеют дополнительных own
keys; пустые validator arrays допустимы. Sparse arrays, symbols, accessors и явный `undefined`
вместо отсутствующей optional metadata отклоняются. Route `body` принимает только прямой class, не
`bodyClass` wrapper.

Schema keys `__proto__`, `prototype` и `constructor` запрещены на любой глубине. Остальные строки,
включая пустую и Unicode, допустимы. Такой входной ключ не материализуется и рассматривается как
unknown field.

Metadata глубоко копируются во внутренний frozen null-prototype compiled plan. Мутации route,
schema, descriptors и arrays после публикации не влияют на него; functions/constructors сохраняют
identity. Первый успешно опубликованный plan constructor закрепляется в конкретном `Application` и
переиспользуется последующими registrations; failed transaction ничего не закрепляет. Plans разных
`Application` независимы.

Fixed registration limits одного root contract:

- 128 уникальных class constructors;
- 1 024 schema fields суммарно;
- 32 уровня descriptor nesting;
- 32 validators на одно field/root место;
- 4 096 validator references суммарно.

Циклический schema graph считает constructor один раз. Превышение даёт registration contract error.

Fixed request limits одной contract operation: 64 уровня входного JSON, 100 000 посещённых JSON
values и 100 violations. Validation, freezing и materialization не используют рекурсивный
JavaScript call stack. Depth/value overflow является client validation failure `400`. При
переполнении violations сохраняются первые 99 и добавляется сотая терминальная
`TOO_MANY_VIOLATIONS` на root path. Эти пределы применяются поверх byte-level `bodyLimit`.

Registration обнаруживает неверные classes/schemas/descriptors, proxy/getter, resolver failure,
неверные built-in parameters, validator declarations, `required()` position/duplicates,
descriptor incompatibility и schema limits. На ingress остаются raw body errors, client shape и
complexity violations, validator-returned violations, cancellation и application bugs. Validator
throw/thenable/malformed result, constructor/prototype failure и materialization failure дают
безопасный `500`, а не client violation.

Validators, resolvers и constructors являются доверенным синхронным application code. Framework
ловит обычные exceptions и защищает свои snapshots, но не предоставляет sandbox, timeout или
защиту от блокировки event loop, `process.exit()` и изменения globals.

Registration error message содержит HTTP method/path, имя root class и metadata path; текст
предназначен для диагностики и не является стабильным public contract. Framework не читает
произвольные application values для его построения.
