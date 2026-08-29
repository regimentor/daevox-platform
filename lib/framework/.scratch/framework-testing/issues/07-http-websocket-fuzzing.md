Status: ready-for-human

# Добавить WebSocket frame и HTTP malformed-input fuzzing

Проверить, что повреждённый сетевой ввод приводит только к корректному ответу, ожидаемому close code или контролируемому разрыву соединения, но не к падению, зависанию или утечке ресурсов.

## Требования

- Создать seed-based генератор и корпус минимальных известных случаев; при сбое всегда выводить seed и сохранять входные байты.
- Для WebSocket генерировать fragmented и continuation frames, control frames между фрагментами, неверные opcode/RSV/mask, длины 7/16/64 bit, неполные frames и некорректный UTF-8.
- Проверить несколько frames в одном TCP chunk и один frame, разбитый на множество chunks.
- Генерировать неверные close frames, ping flood, oversized control/data frames и случайные JSON-envelope после валидного handshake.
- Для HTTP генерировать повреждённый request target и percent-encoding, конфликтующие framing headers, неверный UTF-8/JSON, обрыв тела, неверный `Content-Length`, длинные headers и медленную передачу около `bodyLimit`.
- Ограничивать размер, глубину, число операций и время одного case, чтобы сам fuzzer не создавал неограниченное потребление ресурсов.
- После каждого фатального случая проверять ожидаемое закрытие соединения, а после recoverable WebSocket-ошибки — возможность обработать следующее корректное сообщение.
- Добавить короткий фиксированный corpus-прогон в обычный CI и расширенный генеративный прогон отдельной командой.
- Реализовать команду точного replay по seed и сохранённому case.

## Критерии приёмки

- Любой case завершается ответом, протокольным закрытием или контролируемым reset в пределах timeout.
- Fuzzer обнаруживает контрольные намеренно внесённые нарушения frame parsing и HTTP body limit.
- Сбой содержит минимально необходимые данные для локального replay.
- После серии повреждённых соединений приложение принимает новый корректный HTTP-запрос и WebSocket handshake.
- Нет `uncaughtException`, `unhandledRejection` и роста незакрытых соединений между cases.
- Все исходники имеют расширение `.js`, `npm run check` проходит.

## Comments

Реализован black-box fuzz harness с фиксированным corpus для обычного CI, расширенным
seed-based профилем, ограничениями размера, глубины, операций и полного времени case.
Покрыты повреждённые HTTP-запросы, WebSocket fragmentation/continuation/control/length/UTF-8,
случайные JSON-envelope, восстановление соединения и итоговые HTTP/WebSocket health checks.
Сбой сохраняет исходные байты и JSON-артефакт с seed, конфигурацией, chunk boundaries и
командой точного replay; replay негативной контрольной мутации проверен тестом. Добавлены
команды `fuzz:corpus`, `fuzz:full`, `fuzz:replay` и документация в `docs/system-testing.md`.
Негативные контроли обнаруживают нарушения WebSocket mask parsing и HTTP body limit.
`npm run check` проходит: 133 теста и smoke benchmark без ошибок.
