Type: task
Status: ready-for-agent
Blocked by: 03

# Добавить готовые authentication strategy presets

Реализовать стандартные credential strategies поверх transport-neutral ядра, не встраивая во
framework формат session store, token provider или внешнюю базу.

## Требования

- Реализовать `cookieSession`, `bearerToken` и `oneTimeWebSocketTicket` по callback-контрактам
  завершённой [`../spec.md`](../spec.md).
- Строго извлекать только свой credential, возвращать `abstain` при отсутствии и `rejected` при
  невалидном, просроченном или повторно использованном credential.
- Делегировать разрешение credential в каноническую `AuthSession` пользовательскому callback.
- Не логировать и не включать raw cookie, bearer или ticket в ошибки, results или contexts.
- Для ticket использовать только выбранный спецификацией handshake carrier; consume должен быть
  однократным и делегирован пользовательскому callback.
- Не добавлять framework-owned session state, JWT/OIDC validation, issuance endpoint, refresh flow
  или runtime-зависимости.
- Добавить unit-тесты на отсутствие credential, parsing, malformed input, callback errors, expiry,
  replay результата consume и mutation пользовательской конфигурации.

## Критерии приёмки

- Типовой browser cookie flow и bearer → one-time ticket flow собираются из публичных factories и
  пользовательских callbacks без изменения transport.
- Каждая factory следует общему strategy contract и безопасной семантике fallback.
- Secrets не появляются в `Error.message`, `cause`, inspection и observer contexts framework.
- Production-код имеет двуязычный JSDoc; `npm run docs:build` и `npm run check` проходят.

## Comments
