Status: resolved
Type: research

# Выбрать основу для multipart-парсинга

## Question

Можно ли на Node.js 26 безопасно и предсказуемо разобрать ограниченное `multipart/form-data` в
Fetch-подобные `FormData`/`File` без runtime-зависимости, или спецификация должна разрешить
конкретную стороннюю зависимость? Сравнить варианты по malformed input, лимитам, памяти,
интеграции с `IncomingMessage`, сопровождению и ограничениям ADR 0001.

## Answer

Для принятого ограниченного буферизованного чтения runtime-зависимость не нужна. Framework сначала
применяет общий `bodyLimit`, затем создаёт внутренний `Response` из ограниченного snapshot bytes и
исходного `Content-Type` и вызывает встроенный в Node.js 26 `formData()`. Результатом служат нативные
`FormData` и `File`, а `IncomingMessage` не выходит за transport boundary.

Цена варианта: eager parser не даёт отдельных лимитов `parts`, `files` и `fileSize`, а создание
`File` способно увеличить пиковую память дополнительными копиями. Поэтому первая спецификация
обещает только aggregate `bodyLimit`, нормализует внутренние parser errors и явно документирует
in-memory lifecycle файлов.

Если будущему streaming-effort потребуются отдельные multipart-лимиты, рекомендуемый кандидат —
`@fastify/busboy` версии не ниже 3.2.2. Для текущего контракта его необходимость не доказана, поэтому
добавление зависимости противоречило бы предпочтению ADR 0001.

Подробности и первичные источники: [исследование multipart-парсинга](../research/multipart-parser-dependencies.md).
