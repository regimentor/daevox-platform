Status: resolved
Type: grilling
Blocked by: 01, 03, 05

# Встроить контракт в reader и middleware lifecycle

## Question

Каковы точные API и state machine ленивой материализации поверх one-shot `HttpRequestBodyReader.json()`, чтобы route
middleware и HTTP-обработчик делили один success/failure cache конкретного route contract? Определить повторные и
параллельные вызовы, взаимодействие с `used`, application/controller-wide middleware, cancellation, ошибку повторного чтения и
момент вызова user constructors/validators.

## Answer

Один `HttpRequestBodyReader` найденного HTTP-маршрута хранит state одного запроса. Для route с
`body` первый `json()` синхронно переводит `used` в `true` и запускает ровно одну
parse → structural validation → validators → materialization operation. Параллельные и последующие
`json()` присоединяются к общему cache: success возвращает тот же root instance, failure отклоняется
тем же error object; identity самих Promise не гарантируется.

Исключение из прежней strict one-shot semantics относится только к повтору contract-aware
`json()`. Если первой вызвана `text()`, `bytes()` или `formData()`, последующий contract `json()`
отклоняется `TypeError`. После первого contract `json()` все другие representations также
отклоняются `TypeError`. Raw parsed JSON на route с contract наружу не выдаётся. На route без
`body` reader сохраняет прежнюю strict one-shot семантику для всех операций.

Public reader methods никогда не бросают синхронно: `used` меняется до возврата, а parser error,
validation failure, abort, повторное/конкурирующее несовместимое чтение и application bug всегда
приходят как rejected Promise.

Контракт полностью lazy. Short-circuit middleware без вызова `json()` не запускает parsing,
validation, validators или body constructors и может вернуть ответ независимо от malformed body.
Любой уровень middleware может первым вызвать `json()`; application/controller-wide middleware
получает фактический contract result с типом `unknown`, а route middleware и handler — со связанным
типом. Middleware, прочитавшее JSON и затем выполнившее short-circuit, оставляет cache, но controller
instance не создаётся.

Ошибки распространяются обычным rejected Promise и catchable любым окружающим middleware. Если
middleware перехватило failure и всё же вызвало `next()`, следующий consumer получает cached
failure; fallback к raw/другой representation отсутствует. Неперехваченные ожидаемые body и
validation errors дают безопасный `400`/`415`; reader misuse, validator и constructor bugs дают
`500` и наблюдаются `http.onError` ровно один раз как итоговая ошибка middleware chain.

Если `ctx.signal` уже aborted при первом `json()`, cache получает стандартный `AbortError`, не
запуская parsing или constructors. Начавшаяся синхронная validation/materialization не получает
искусственных async checkpoints и не может быть прервана событием из того же event loop; поздний
abort не инвалидирует success value. Предшествующее buffering и его cancellation остаются
контрактом базового reader.

Cache не разделяется между запросами или HTTP-маршрутами и живёт столько же, сколько reader/context
или сохранённая приложением ссылка. Между запросами разделяется только immutable compiled schema
plan. Validators и constructors выполняются максимум один раз на request contract operation.
