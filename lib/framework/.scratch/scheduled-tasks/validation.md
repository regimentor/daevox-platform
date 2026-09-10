# Проверка реализации ScheduledTask

Дата: 2026-09-10. Node.js 26.8.1. Изменения реализации, примеров, тестов и документации ограничены
`lib/framework/`. Существовавшие до запроса изменения в `apps/`, корне и других packages сохранены.
Три новых CSS declaration-файла, созданные общим verify, удалены после проверки.

## Публичные границы и coverage

Подтверждённые пользователем seams: Application, ScheduledTaskBase, публичные TypeScript-типы.
Внутренние runtime и cron проверяются через регистрации и наблюдаемые запуски Application;
нет unit-тестов приватного scheduler API или моков внутренних collaborators.

Команда `npm run test:scheduled:coverage --workspace @daevox/framework` проходит: 45 тестов,
ноль failures/skips. Порог зафиксирован в package script и составляет 100% по каждой метрике.

| Production-модуль         | Строки | Ветви | Функции |
| ------------------------- | ------ | ----- | ------- |
| `ScheduledTaskBase.ts`    | 100%   | 100%  | 100%    |
| `ScheduledTaskRuntime.ts` | 100%   | 100%  | 100%    |
| `scheduledCron.ts`        | 100%   | 100%  | 100%    |

Это coverage новой реализации, а не заявление о 100% всего исторического Application/framework.
Новые регистрационные методы и integration hooks Application покрыты публичными lifecycle-тестами.

## Проверки, прошедшие успешно

- Typecheck framework, включая compile-time отказ для несовместимого AppState, неверного результата
  run и отсутствующих cron/run; допустимы одноаргументный run и обычный метод, возвращающий Promise.
- Lint всех изменённых файлов, format check framework, docs:build и docs:check.
- Полный unit/e2e-набор framework: 232 unit и 20 e2e, включая transport shutdown и Worker races.
- `test:checks`: 21 тест системных harness.
- `test:soak-harness`: четыре теста, включая отрицательные контроли listener/timer/socket leaks.
- `mutation:changed`: 16 mutants, score 100%, ноль survived/no-coverage. Двенадцать новых контролей
  проверяют ScheduledTask, четыре существующих — изменённый Application. Timeout мутанта считается
  обнаружением по принятой политике harness. [Отчёт](../../test/mutation/results/changed.md).
- `benchmark:full`: все профили завершились с нулевыми ошибками операций. Сравнение производительности
  с baseline **skipped**, поскольку fingerprint локального окружения отличается. Это локальный
  функциональный прогон, не подтверждение performance gate выделенного CI.

## Общий gate и ограничения окружения

`npm run verify` из корня запускался. Он блокируется существующими lint-ошибками отдельного
прототипа `.scratch/http-route-json-body-contract/prototypes/public-contract.ts` внутри framework:
неиспользуемые `WrongDescriptorDto` (строка 252), `WrongNullabilityDto` (273), пустой класс (115).
Этот прототип не относится к ScheduledTask и не изменялся. Из-за short-circuit framework verify
его unit/e2e и системные harness дополнительно запускались отдельными командами.

Первый `stress --mode full` с 32 доступными CPU остановлен защитой памяти 768 MiB: штатный профиль
формирует pool sizes относительно availableParallelism. Повтор с CPU affinity `0,1` прошёл нагрузку,
но не порог recovery `application-event-throughput`; он выполнялся одновременно с общим verify.
Итог отдельного прогона на четырёх CPU приведён ниже.

Четырёхчасовой `soak:scheduled` не выполнялся: требуемое документацией однородное выделенное
окружение недоступно. Короткие проверки и естественный выход отдельного Node-процесса после
20 Application lifecycle-циклов не заменяют этот release/CI-профиль.

## Финальные профильные результаты

- `taskset -c 0-3 npm run stress --workspace @daevox/framework`: **passed**. Полный набор ступеней,
  лимиты и пороги сохранены; процесс видит четыре CPU. [Артефакт](../../test/stress/results/2026-09-09T20-42-44.497Z.json).
- Последнее исправление касается единственного scheduler timer при регистрации из выполняющейся
  задачи; оно дополнительно подтверждено native resource audit, полным unit/e2e и coverage gate.
- [Локальный benchmark](../../test/benchmark/results/2026-09-09T20-41-59.274Z-full.json):
  шесть профилей, 0% ошибок операций, regression comparison skipped из-за другого fingerprint.
- `soak:short`: **passed** — heap/RSS, latency, возврат ресурсов, операции, lifecycle и учёт events.
  [Артефакт](../../test/soak/results/2026-09-09T20-49-37.165Z-short.json).
