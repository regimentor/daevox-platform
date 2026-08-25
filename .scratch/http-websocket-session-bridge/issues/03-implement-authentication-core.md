Type: task
Status: ready-for-agent
Blocked by: 02

# Реализовать ядро Authentication

Реализовать transport-neutral модуль strategies/scenarios по завершённому контракту
[`../spec.md`](../spec.md), не подключая его пока к HTTP- и WebSocket-lifecycle.

## Требования

- Добавить публичную точку композиции `Authentication` в форме, выбранной спецификацией.
- Строго и атомарно нормализовать каталоги именованных strategies и scenarios, копируя
  пользовательские декларации.
- Проверять имена, exact-key формы, ссылки scenario на strategies, порядок, required/optional и
  неизвестные/symbol-поля.
- Реализовать единый async запуск scenario с результатами `abstain`, `rejected` и `authenticated`.
- Продолжать fallback только после `abstain`; после `rejected` не вызывать следующие strategies.
- Проверять строгую форму `AuthSession`, не доверять непроверенному `authSessionId` и не объединять
  результаты по `principal.id`.
- Передавать strategy только нормализованный input и `AbortSignal`; transport objects не раскрывать.
- Реализовать согласованные public errors и безопасно сохранять `cause`, не раскрывая credentials.
- Добавить unit-тесты на sync/async strategies, mutation isolation, fallback, optional/required,
  invalid results, thrown errors и отмену.
- Не добавлять built-in credential factories и transport integration в этой задаче.

## Критерии приёмки

- Модуль одинаково обрабатывает HTTP- и WebSocket-input без зависимости от transport classes.
- Невалидная конфигурация отклоняется до запуска listener и не оставляет частичного каталога.
- `rejected` никогда не приводит к downgrade на следующую strategy.
- В результатах и ошибках framework отсутствуют raw credential, request и socket.
- Production-код имеет двуязычный JSDoc; `npm run docs:build` и `npm run check` проходят.

## Comments
