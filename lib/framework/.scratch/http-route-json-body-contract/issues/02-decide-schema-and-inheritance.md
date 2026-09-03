Status: resolved
Type: grilling
Blocked by: 01

# Определить схему, рекурсию и наследование классов

## Question

Каковы точные runtime- и TypeScript-контракты `static schema`, дескрипторов `String`, `Number`,
`Boolean`, `null`, прикладного класса и одноэлементного array descriptor? Определить пустые массивы,
finite-number policy, `null` против отсутствия, рекурсивные и циклические class references, а также
наследование `static schema`: допускаются ли subclasses, как объединяются поля и какой точный constructor
считается типом поля или корня.

## Answer

`static schema` является единственным runtime-источником истины и исчерпывающим списком входных
полей. Она описывает все public non-function properties прикладного класса; compile-time
`satisfies HttpRouteJsonBodySchema<T>` и registration proof запрещают пропущенные и лишние entries,
а runtime проверяет фактически доступную schema. Пустая schema `{}` допустима и принимает только
пустой JSON object.

Корневой `body: UserDto` первой версии принимает только JSON object и при успехе возвращает точный
экземпляр `UserDto`. Все JSON-совместимые формы поддерживаются рекурсивно как поля объекта;
top-level scalar и array contracts не входят в первую версию.

Field entry имеет форму `{ type, nullable?, validators? }`. Отсутствие поля разрешено по умолчанию,
а обязательность задаёт `required()`. Отсутствие и JSON `null` независимы: `null` принимается только
descriptor `null` либо обычным descriptor с `nullable: true`; отсутствующее optional-поле остаётся
`undefined` в экземпляре.

Descriptors работают строго, без coercion:

- `String` принимает любую JSON-строку;
- `Number` принимает только finite number;
- `Boolean` принимает только boolean;
- `null` принимает только `null`;
- `[D]` принимает массив любой длины, включая пустой, и рекурсивно применяет `D` к каждому элементу;
- уже инициализированный class задаётся напрямую, например `type: AddressDto`;
- self/forward class reference задаётся явно как `bodyClass(() => NodeDto)` и также допустим внутри
  array descriptor.

Callback `bodyClass()` вычисляется ровно один раз при регистрации; framework сохраняет точный
возвращённый constructor. Повторное появление constructor завершает обход уже известного class,
поэтому self- и mutual-recursive schema graphs разрешены. Конечность, глубина и размер конкретного
JSON-дерева ограничиваются отдельной safety policy.

TypeScript-поле может иметь только точный широкий тип `string`, `number`, `boolean`, `null`, тип
контрактного класса или обычный mutable/readonly однородный массив такого типа, с добавлением
`null` и/или `undefined`. Literal/heterogeneous unions, tuples, enums, branded primitives, records и
произвольные interfaces не поддерживаются: descriptor не способен гарантировать их более узкую
семантику без отдельного контракта.

Наследование контрактных классов полностью запрещено. Root и nested class descriptor всегда
означает ровно сохранённый constructor; subclass substitution и объединение inherited schemas
отсутствуют.
