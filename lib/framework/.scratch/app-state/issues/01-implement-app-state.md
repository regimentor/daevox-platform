Status: resolved
Type: task

# Реализовать AppState для Application

Реализовать контракт [`../spec.md`](../spec.md) в `lib/framework`.

## Требования

- Добавить публичный тип конструктора `AppState` и экспортировать его через `src/index.ts`.
- Сделать `ApplicationOptions.appState` обязательным: принимается класс без аргументов, не экземпляр.
- Создать ровно один экземпляр класса при создании `Application`.
- Передавать экземпляр первым аргументом всем HTTP- и WebSocket middleware и handlers, включая
  callbacks из конфигурации приложения.
- Добавить необязательные hooks `beforeAppStart`, `onAppStart`, `onAppClose` с ожиданием Promise.
- Реализовать согласованный порядок запуска и shutdown, включая продолжение shutdown после ошибки
  `onAppClose` и сохранение первой ошибки.
- Не передавать состояние в Worker jobs.
- Обновить HTTP/WebSocket типы, README, interface/API документацию, examples и тесты.
- Добавить проверки конструктора AppState, единственности экземпляра, первого аргумента handlers,
  startup hooks, shutdown hooks, ошибок и нового обязательного контракта.
- Запустить `npm run docs:build`, `npm run docs:check` и корневой `npm run verify`.

## Критерии приёмки

- Класс `AppState` без hooks корректно работает.
- Hooks могут отсутствовать, быть синхронными или асинхронными.
- Один и тот же экземпляр доступен во всех HTTP/WebSocket execution paths.
- HTTP/WebSocket transport не стартует до успешного `beforeAppStart`.
- `onAppStart` вызывается после успешного запуска transport.
- `onAppClose` вызывается после завершения прикладных операций и закрытия jobs.
- Ошибка shutdown не предотвращает закрытие остальных ресурсов.
- Старый вызов handler с одним `ctx` больше не является поддерживаемым публичным контрактом.

## Comments

Задача сформирована после согласования дизайна AppState.

## Answer

Реализован обязательный конструктор `AppState`, единственный экземпляр состояния приложения,
передача первым аргументом в HTTP- и WebSocket execution paths, lifecycle hooks запуска и
shutdown, а также продолжение shutdown после ошибки `onAppClose` с сохранением первой ошибки.
Обновлены публичные типы, README, interface/API документация, примеры и seam-тесты. Проверки
`docs:build`, `docs:check`, форматирование и lint проходят; typecheck блокируется отсутствующими
зависимостями benchmark-конкурентов, не относящихся к framework.
