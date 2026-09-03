Status: resolved
Type: grilling
Blocked by: 01, 02

# Определить validator contract и встроенный набор

## Question

Каковы точные синхронные сигнатуры field/root validators, их context, порядок, short-circuit и exception policy?
Определить семантику `required()`, взаимодействие optional-полей с остальными validators, коды и messages,
а также минимальный встроенный набор для strings, finite numbers, arrays и objects, начиная с `minLength()` и `min()`.

## Answer

Registration создаёт immutable execution plan из schema, разрешённых class references и снимков
validator arrays. Для каждого запроса structural validation сначала строит и затем глубоко
замораживает собственный граф, полученный из `JSON.parse`; отдельная копия plain graph не создаётся.
Этот request-specific validation snapshot невозможно подготовить при регистрации, но его обход
использует заранее скомпилированный plan.

Field и root validators разделены:

```ts
type HttpRouteJsonBodyFieldValidator<Value> = (
  value: ReadonlyJson<Value>,
  context: { readonly path: readonly (string | number)[] },
) => { readonly code: string; readonly message: string } | undefined;

type HttpRouteJsonBodyRootValidator<Body> = (body: HttpRouteJsonBodyInput<Body>) =>
  | {
      readonly path?: readonly (string | number)[];
      readonly code: string;
      readonly message: string;
    }
  | readonly {
      readonly path?: readonly (string | number)[];
      readonly code: string;
      readonly message: string;
    }[]
  | undefined;
```

`ReadonlyJson<T>` и `HttpRouteJsonBodyInput<T>` являются глубокими readonly JSON-проекциями без
методов и class identity. Field path — замороженный абсолютный список string keys и
неотрицательных integer indices. Root path задаётся относительно корня; отсутствие path означает
сам корень. JSON Pointer кодируется framework позднее.

Validation выполняется фазами:

1. полностью проверить structure, descriptors, extra fields, presence и nullability всего дерева;
2. при структурном успехе выполнить field validators depth-first в порядке schema и array elements;
3. при отсутствии field violations выполнить class root validators bottom-up, затем root contract;
4. только после полного успеха начать materialization.

Все validators текущей фазы выполняются в declaration order, а корректные violations
агрегируются. Root phase не запускается после field violations. Первое exception, malformed return
либо Promise/thenable немедленно прекращает validation, отбрасывает накопленные client violations и
становится contract/application bug с безопасным `500`.

`required()` является специальным presence-validator: допускается максимум один раз и только на
первом месте. Отсутствующее optional-поле пропускает остальные validators; отсутствующее required
поле даёт одну violation `REQUIRED`. Присутствующий `null` не является отсутствием. Для descriptor
`null` `required()` означает, что ключ обязан присутствовать со значением `null`.

Минимальный built-in набор и стабильные результаты:

| Validator      | Допустимые значения | Code         | Message                                 |
| -------------- | ------------------- | ------------ | --------------------------------------- |
| `required()`   | любое поле          | `REQUIRED`   | `Required`                              |
| `minLength(n)` | string/array        | `MIN_LENGTH` | `Must have length at least ${n}`        |
| `maxLength(n)` | string/array        | `MAX_LENGTH` | `Must have length at most ${n}`         |
| `min(n)`       | number              | `MIN`        | `Must be greater than or equal to ${n}` |
| `max(n)`       | number              | `MAX`        | `Must be less than or equal to ${n}`    |
| `integer()`    | number              | `INTEGER`    | `Must be an integer`                    |

String length считается в Unicode code points; array length — в элементах. Length parameters —
неотрицательные integers, numeric bounds — finite numbers; `-0` нормализуется в `0`, а bounds в
messages форматируются каноническим `String(n)`. Built-in messages не переопределяются параметрами.
Для object отдельного size-validator нет: shape фиксирует schema, presence покрывает `required()`.

Custom violation code соответствует `^[A-Z][A-Z0-9_]*$`, message является непустой строкой, а root
path состоит из string keys и неотрицательных integer indices. Field validator возвращает не более
одной violation, root validator — одну или массив. Malformed result является validator bug. Custom
message считается безопасным публичным текстом приложения: framework не добавляет input values, но
не может предотвратить их раскрытие самим validator. Reserved codes и size limits завершаются в
общей error model.

Validators вызываются как обычные синхронные функции с `this === undefined`; contexts и paths
заморожены. Framework не клонирует callable: один validator может использоваться несколькими
routes/requests, а mutable closure state и любые гарантии порядка остаются ответственностью
приложения. I/O и asynchronous validators не поддерживаются.
