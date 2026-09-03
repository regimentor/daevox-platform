# Зависимости для разбора `multipart/form-data`

Дата проверки: 2026-09-03. Целевая платформа: Node.js 26.

## Краткий ответ

Для принятого в этой инициативе **ограниченного буферизованного** чтения runtime-зависимость не
нужна. Node.js 26 стабильно предоставляет совместимые с Web API `Response`, `FormData` и `File`;
ограниченные байты и исходный `Content-Type` можно передать во внутренний `Response`, затем вызвать
`response.formData()`. Получится нативный `FormData` со строками и `File` без раскрытия
`IncomingMessage` и без добавления npm-пакета. [Node.js: глобальные Fetch-классы](https://nodejs.org/api/globals.html#fetch)

Это решение допустимо только после того, как framework сам ограничил **всё исходное тело** через
`http.bodyLimit`. Реализация Undici сначала полностью читает body, затем разбирает накопленные байты;
сам `formData()` не предоставляет лимитов числа частей, полей или файлов. Undici прямо предупреждает,
что метод полностью буферизует multipart и для недоверенного неограниченного потока нужен отдельный
streaming parser. [Undici: Body Mixins](https://github.com/nodejs/undici#body-mixins),
[реализация `consumeBody`](https://github.com/nodejs/undici/blob/v8.9.0/lib/web/fetch/body.js#L494-L531)

## Что именно даёт встроенный вариант

- `formData()` принимает только `multipart/form-data` и
  `application/x-www-form-urlencoded`; неподходящий media type и ошибка multipart-разбора приводят к
  отклонённому promise с `TypeError`. Это соответствует Fetch-контракту однократного потребления body.
  [Fetch Standard: Body mixin](https://fetch.spec.whatwg.org/#body-mixin),
  [Undici 8.9.0: `formData()`](https://github.com/nodejs/undici/blob/v8.9.0/lib/web/fetch/body.js#L432-L467)
- Multipart-файл материализуется как `File([body], filename, { type })`, то есть это eager
  представление. Node копирует `Buffer`/typed-array bytes при создании `Blob`, поэтому пиковая память
  может быть больше `bodyLimit`: одновременно могут жить исходный накопленный body, служебные данные
  парсера и копии содержимого файлов. [Undici: создание `File`](https://github.com/nodejs/undici/blob/v8.9.0/lib/web/fetch/formdata-parser.js#L206-L215),
  [Node.js: `Blob` копирует byte sources](https://nodejs.org/api/buffer.html#new-bufferblobsources-options)
- У parser API нет параметров `files`, `parts`, `fieldSize` или `fileSize`. Единственная надёжная
  ресурсная граница при таком выборе — установленный framework до разбора общий `bodyLimit`; если
  спецификации нужны независимые лимиты количества частей/файлов или размера отдельного файла,
  встроенного API недостаточно.
- Malformed boundary, отсутствующая boundary и незавершённые/неверные части отвергаются, а успешные
  поля сохраняют повторы через семантику `FormData`. При этом конкретный текст внутренних ошибок не
  является подходящим публичным контрактом framework: parser возвращает собственные parsing errors,
  которые следует нормализовать. [Undici: multipart parser](https://github.com/nodejs/undici/blob/v8.9.0/lib/web/fetch/formdata-parser.js)
- Для текущей eager-модели интеграция с `IncomingMessage` не нужна: сначала единый reader framework
  накапливает ограниченные bytes, потом все методы (`json()`, `text()`, `bytes()`, `formData()`)
  используют этот snapshot. Если когда-либо потребуется прямой Fetch-body stream, Node умеет
  преобразовать Node `Readable` в Web Stream через `Readable.toWeb`; это, однако, не делает
  `formData()` потоковым. [Node.js: interoperability потоков](https://nodejs.org/api/webstreams.html#nodejs-streams-interoperability)

## Сторонние варианты

| Вариант                          | Поведение и интеграция                                                                                                                                                                                         | Лимиты и ошибки                                                                                                                                                                                                                                                                                             | Стоимость сопровождения                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Встроенный `Response.formData()` | Eager: полностью читает bytes, возвращает стандартный `FormData`/`File`. Для принятой модели можно передать уже ограниченный snapshot.                                                                         | Общий `bodyLimit` обеспечивается framework; отдельных multipart-лимитов нет; malformed input даёт rejected `TypeError`.                                                                                                                                                                                     | Ноль npm runtime-зависимостей; parser поставляется и обновляется вместе с Node/Undici.                                                                                                                                                                                                                                                                                                                                                                                    |
| `@fastify/busboy` 3.2.2          | Streaming `Writable`; `IncomingMessage` напрямую `pipe()`-ится в parser, файлы приходят отдельными readable streams. Для возврата `FormData` framework всё равно должен накопить файлы и сам построить `File`. | Есть `fieldSize`, `fileSize`, `fields`, `files`, `parts`, header limits и события достижения лимита. Потоки файлов обязательно потреблять; parser может синхронно бросить на отсутствующем/неподдерживаемом `Content-Type`, malformed stream сообщает ошибкой. [API](https://github.com/fastify/busboy#api) | Одна runtime-зависимость, CommonJS, TypeScript declarations включены, runtime dependencies отсутствуют (по package manifest код поиска и декодирования vendored). Проект активен, но требует оперативных обновлений: 3.2.1 исправил два DoS, 3.2.2 — CR/LF injection. [manifest](https://github.com/fastify/busboy/blob/v3.2.2/package.json), [releases](https://github.com/fastify/busboy/releases), [advisories](https://github.com/fastify/busboy/security/advisories) |
| `busboy` 1.6.0                   | Также streaming `Writable`, напрямую принимает headers и pipe от `IncomingMessage`; события отличаются от fork API. Не создаёт `FormData`/`File`.                                                              | Есть multipart-лимиты и `truncated`/limit events; незавершённая форма даёт parser error. [README/API](https://github.com/mscdex/busboy/blob/v1.6.0/README.md)                                                                                                                                               | Один прямой пакет плюс runtime dependency `streamsearch`; версия 1.6.0 опубликована в 2022 году и остаётся latest. В manifest нет встроенных TypeScript declarations. Это слабее согласуется с Node 26 и ADR 0001, чем активно обновляемый fork. [manifest](https://github.com/mscdex/busboy/blob/v1.6.0/package.json), [npm versions](https://www.npmjs.com/package/busboy?activeTab=versions)                                                                           |

`@fastify/multipart`, Multer и Formidable здесь не дают преимущества: это более высокоуровневые
middleware/storage abstractions, тогда как framework нужен узкий parser seam и собственная
нормализация в Fetch-подобное представление.

## Вывод и рекомендация

Для этой карты выбрать **встроенный `Response.formData()` без runtime-зависимости**, при следующих
обязательных условиях будущей спецификации:

1. общий `bodyLimit` применяется во время чтения и до multipart-парсинга, в том числе при chunked
   transfer и ложном/отсутствующем `Content-Length`;
2. `formData()` работает с одним кэшированным ограниченным snapshot тела и возвращает нативный
   `FormData`/`File`;
3. ошибки media type, malformed multipart, отмены и превышения лимита нормализуются framework и не
   раскрывают тексты/классы внутренних ошибок Undici;
4. документация явно сообщает eager/in-memory природу файлов и учитывает пиковые копии сверх
   `bodyLimit` при выборе безопасного default;
5. отдельные multipart-лимиты (`parts`, `files`, `fileSize`) не обещаются в первой версии. Если они
   станут обязательным требованием либо начнётся отдельный streaming effort, тогда разрешить
   **`@fastify/busboy` версии не ниже 3.2.2** как наиболее подходящего кандидата и отдельно решить
   lifecycle потоков/временных файлов.

Таким образом, сторонняя зависимость сейчас не доказана необходимой и её добавление противоречило бы
предпочтению ADR 0001. `@fastify/busboy` — обоснованный кандидат для будущего streaming-контракта,
но не нужен для ограниченного Fetch-подобного `formData()`.
