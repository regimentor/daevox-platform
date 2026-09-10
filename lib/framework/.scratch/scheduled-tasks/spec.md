# ScheduledTask: реализация согласованной концепции

Основание: [завершённая карта концепции](map.md), её семь резолюций и явный запрос на реализацию
по TDD без изменений `apps/`. Границы тестирования подтверждены пользователем: Application,
ScheduledTaskBase и публичные TypeScript-типы. Внутренние календарь и runtime проверяются через
наблюдаемое выполнение задач; подмена ограничена временем и внешним console.error.

Полный публичный контракт: [capability guide](../../docs/interface/scheduled-tasks.md).
Порядок завершения и причины выбора: [ADR 0016](../../docs/adr/0016-scheduled-tasks.md).

## Состав реализации

- `ScheduledTaskBase`, `ScheduledTaskClass`, `ScheduledTaskOptions`, `ScheduledTaskContext`,
  `ScheduledTasksOptions`, `ScheduledTaskErrorContext`, `ScheduledTaskShutdownTimeoutError`.
- `Application.registerScheduledTask()` и `registerRuntimeScheduledTask()` с одинаковой проверкой,
  независимой идентичностью constructor и атомарной публикацией snapshot cron.
- Шестипольный календарь на Node Date/Intl без runtime-зависимостей. Числа, wildcard, списки,
  диапазоны и шаги; невозможные даты, локальный пояс, DST, объединение пропусков и коррекция часов.
- Новый экземпляр на запуск, исключение перекрытия, общий AppState и DI трёх capability.
- Изоляция constructor/run/onError, проверка настоящего Promise, отсутствие retry и run timeout.
- Синхронная остановка расписаний и отмена активных сигналов; общий бюджет после transport
  settlement до events/Job Runner, однократная диагностика cutoff и подавление позднего rejection.

## Трассировка приёмки

| Резолюция                                              | Публичное доказательство                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| [01: объявление](issues/01-declare-contract.md)        | `scheduled-task-base.test.ts`, `scheduled-task-types.test.ts`, malformed declarations и constructor/run tests       |
| [02: календарь](issues/02-cron-semantics.md)           | `scheduled-calendar.test.ts`: известные абсолютные даты, leap day, OR, локальные зоны, обычный и получасовой DST    |
| [03: выполнение](issues/03-execution-policy.md)        | Fresh instances, shared state, busy skip, independent Application; реальный не-ожидаемый Worker в e2e               |
| [04: регистрация](issues/04-registration-lifecycle.md) | Fluent startup/runtime, snapshot, atomic rejection, same-name classes, failed startup и обе startup/close гонки     |
| [05: shutdown](issues/05-errors-shutdown.md)           | Cooperative cleanup, общий cutoff, cancellation, late rejection; реальные Worker/events/WebSocket и HTTP settlement |
| [06: полнота](issues/06-concept-completeness.md)       | Runnable example с Worker Job и async AppState; unit/e2e/type checks                                                |
| [07: границы](issues/07-contract-edges.md)             | Promise/thenable/realm, safe integer timeout включая native overflow, hanging observer, clock correction            |

Тесты находятся в `test/unit/scheduled*.test.ts` и `test/e2e/scheduled-tasks.test.ts`.
Системный lifecycle-тест запускает отдельный Node-процесс, создаёт и закрывает 20 Application
и требует естественного завершения процесса без оставшихся scheduler timers.

## Воспроизведение

```sh
npm run test:scheduled:coverage --workspace @daevox/framework
npm run mutation:changed --workspace @daevox/framework
npm test --workspace @daevox/framework
npm run typecheck --workspace @daevox/framework
npm run docs:check --workspace @daevox/framework
npm run verify
```

Coverage gate требует 100% строк, ветвей и функций во всех новых production-модулях.
Каталог mutations дополнен негативными контролями календаря, перекрытия, Promise-контракта,
активации, отмены, default timeout, порядка закрытия и поздних rejection.
Результаты общих и профильных проверок фиксируются в [validation.md](validation.md).
