Status: resolved
Type: grilling
Blocked by: 02

# Определить однократное чтение и совместимость с ctx.body

## Question

Как Fetch-подобные операции конкурируют друг с другом при повторном или параллельном чтении тела,
и каким должен быть совместимый переход от существующего eagerly parsed `ctx.body`, включая
поведение старых HTTP-обработчиков и middleware?

## Answer

`HttpRequestBodyReader` имеет строгую Fetch-подобную one-shot семантику. Первый вызов любого из
`json()`, `text()`, `bytes()` или `formData()` синхронно переводит `used` в `true`, ещё до проверки
media type, чтения и разбора. Любой последующий или параллельный вызов возвращает отклонённый
`Promise`; reader остаётся использованным и после malformed input, неподходящего media type, отмены
или другой ошибки первого чтения. Вызов при отсутствующем теле также потребляет reader.

HTTP middleware и найденный HTTP-обработчик используют один экземпляр reader. Если middleware
читает тело, оно явно передаёт нужное представление HTTP-обработчику через `ctx.state`; framework не
создаёт скрытый повторно читаемый кэш и не предоставляет привилегированного чтения handler.

Существующее синхронное eagerly parsed `ctx.body` удаляется как breaking change без compatibility
mode и переходного двойного поведения. Все HTTP-обработчики и middleware мигрируют на
`await ctx.requestBody.<operation>()`. Порядок generic-параметров сохраняется как
`HttpRequestContext<JsonBody, State>`, поэтому первый generic продолжает описывать JSON-тело, но
теперь распространяется в `requestBody.json(): Promise<JsonBody>`.

Точный класс ошибки повторного чтения, результаты операций для пустого тела и transport-
нормализация parser errors определяются последующими decision tickets.
