# Запланированные задачи

ScheduledTask — отдельный регистрируемый класс прикладной работы по расписанию.
Он выполняется в основном потоке и при необходимости вызывает Worker Job через `this.jobRunner`.

## Interface

- [Публичные типы и базовый класс](../api/ScheduledTaskBase.md).
- [Регистрация и конфигурация Application](../api/Application.md).
- [Runnable-пример](../../examples/scheduled-tasks/main.ts): Worker Job и асинхронный ресурс AppState.
- [ADR 0016](../adr/0016-scheduled-tasks.md).

## Сводка из ADR

<!-- adr-contract:scheduled-tasks.execution -->

Каждый допущенный запуск создаёт новый ScheduledTask с DI `{ jobRunner, events, websocket }` и общим AppState в аргументе run. Один constructor в одном Application не выполняется параллельно самому себе; пропуски не образуют очередь. Ошибки constructor/run наблюдаются без обёртки через onError; ошибка наблюдателя выводится в console.error без ожидания его Promise. Общий shutdownTimeout по умолчанию 30000 мс не отклоняет close: незавершённые задачи однократно получают ScheduledTaskShutdownTimeoutError, поздние rejection перехватываются без повторного уведомления.

## Регистрация и выполнение

`registerScheduledTask(TaskClass)` доступен до listen, `registerRuntimeScheduledTask(TaskClass)` —
после успешного startup. Оба синхронны, атомарны и возвращают Application. Повтор constructor
запрещён; разные классы с одинаковыми именами или cron допустимы. Конструктор не вызывается при
регистрации. Сохраняется snapshot cron; последующая мутация static cron не меняет расписание.
Первое срабатывание строго позже активации. Startup failure и close запрещают регистрацию.

Собственные поля `cron` и prototype `run` обязательны; статический run, унаследованный метод,
accessor и стрелочное поле не заменяют prototype-метод. Синтаксис async необязателен, но возвращать
нужно Promise<void>; обычное значение наблюдается как TypeError с phase run. Второй аргумент
можно не объявлять. Свойства DI неизменяемы; AppState не входит в DI.

## Календарь

Шесть полей: секунда (0–59), минута (0–59), час (0–23), день месяца (1–31), месяц (1–12),
день недели (0–7; 0 и 7 — воскресенье). Поддерживаются числа, `*`, списки, возрастающие диапазоны
и положительные целые шаги. `5/10` задаёт шаг от 5 до верхнего предела поля; `5-20/5` — в диапазоне.
Имена месяцев/дней, макросы, пятипольные выражения, L/W/#/? и невозможные даты отклоняются.
При двух ограниченных полях дня применяется ИЛИ, при `*` ограничивает другое поле.

Используется часовой пояс процесса при активации Application; его изменение требует перезапуска.
Несуществующее местное время при DST пропускается, повторённое срабатывает дважды в разные
абсолютные моменты. Задержка event loop и скачок часов вперёд объединяют пропуски в один запуск;
следующий момент выбирается в будущем. Коррекция назад не повторяет обработанные моменты.
Проверка системных часов выполняется не реже раза в секунду при свободном event loop.

## Ошибки и завершение

`scheduledTasks.onError(error, { taskClass, taskName, phase })` различает constructor, run и shutdown.
По умолчанию используется console.error. Retry и timeout обычного run отсутствуют. Значение
`scheduledTasks.shutdownTimeout` — положительный safe integer миллисекунд, включая значения
выше предела одного native timer. Общий бюджет начинается после transport settlement.
Отмена signal в начале close кооперативна; закрытие ждёт Promise run до его settlement или cutoff.

## Проверки

```sh
npm run test:scheduled --workspace @daevox/framework
npm run test:scheduled:coverage --workspace @daevox/framework
npm run mutation:changed --workspace @daevox/framework
npm run example:scheduled-tasks --workspace @daevox/framework
```

Coverage gate требует 100% строк, ветвей и функций календаря, базового класса и внутреннего runtime.
Тесты обращаются только к Application, ScheduledTaskBase и публичным типам; время заменяется
на границе Date/timers. E2E проверяют реальные Worker, EventSender и WebSocket.
