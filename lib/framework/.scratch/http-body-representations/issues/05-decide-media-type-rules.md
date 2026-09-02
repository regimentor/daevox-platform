Status: resolved
Type: grilling
Blocked by: 04

# Определить правила Content-Type и кодировок

## Question

Как каждая операция чтения проверяет `Content-Type`, параметры media type и charset; что происходит
при отсутствующем или конфликтующем заголовке; какие suffix-типы JSON и текстовые кодировки входят
в контракт; когда возвращаются `400`, `413` и `415`?

## Answer

Операции применяют семантически строгую политику media type:

- `json()` принимает `application/json` и любой корректный media subtype с суффиксом `+json`;
- `formData()` принимает только `application/x-www-form-urlencoded` и `multipart/form-data`, причём
  multipart требует непустую корректную `boundary`;
- `text()` декодирует любой media type как текст;
- `bytes()` игнорирует `Content-Type` и возвращает исходные bytes.

При наличии тела без `Content-Type` методы `json()` и `formData()` дают `415`, `text()` декодирует
его как UTF-8, а `bytes()` возвращает без преобразования. JSON, text и текстовые значения форм имеют
только UTF-8 wire-контракт: отсутствие `charset` означает UTF-8, явно объявленный другой charset
даёт `415`. Синтаксически корректные неизвестные параметры media type игнорируются; конфликтующие
повторы `charset` или `boundary`, malformed `Content-Type` и отсутствующая multipart boundary дают
`400`.

`json()` строго декодирует UTF-8 и даёт `400` при невалидной последовательности или malformed JSON.
`text()` следует обычному `TextDecoder`: невалидные UTF-8 последовательности заменяются на
`U+FFFD`, а не отклоняются.

`formData()` намеренно сохраняет нативную семантику Node.js 26 `Response.formData()`. Текстовые
значения с невалидным UTF-8 используют replacement decoding; malformed percent escapes
URL-encoded формы обрабатываются tolerant-алгоритмом `URLSearchParams`; произвольные bytes файлов
не декодируются и сохраняются. Framework не добавляет собственную строгую проверку полей поверх
Node parser. Malformed структура multipart даёт `400`.

Категории клиентских отказов:

- отсутствующий или неподдерживаемый media type для `json()`/`formData()` — `415`;
- явно неподдерживаемый charset — `415`;
- malformed или конфликтующий `Content-Type`, отсутствующая boundary, malformed JSON или структура
  multipart — `400`;
- превышение aggregate body limit — `413`.

Проверка на Node.js 26.7.0 с Undici 8.9.0 подтвердила replacement decoding для URL-encoded и
multipart text fields, tolerant malformed percent escapes и точное сохранение file bytes. Точные
error-классы и преобразование rejected operations в HTTP-ответ определяются последующим ticket.
