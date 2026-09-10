# Гарантии отправки TDLib и граница новых сообщений

Type: research
Status: resolved
Assignee: codex-research
Labels: wayfinder:research
Parent: ../map.md

## Question

Какие гарантии закреплённой TDLib и текущего адаптера Daevox определяют автоответ от личного аккаунта только на новые сообщения?

Исследовать sendMessage, pending/succeeded/failed, смену временных ID, ответ на конкретное сообщение и тему, права отправки в разных типах чатов, is_outgoing и messageSenderChat, username/name, ограничения длины и flood wait. Проверить, можно ли отличить live от доставленного после reconnect backlog, какие гарантии дедупликации доступны при перезапуске и неоднозначном результате отправки. Сопоставить локальную схему с первичными официальными источниками; явно отделить факты от предложений.

Не обращаться к аккаунту, не читать личную переписку, не отправлять сообщения. Результат — один Markdown на исследовательской ветке, Answer с ссылкой на файл, branch и commit. Продуктовых решений не принимать.

## Answer

Исследование завершено: [TDLib: доставка автоответов и граница новых сообщений](../research/delivery.md). Закреплённая схема поддерживает reply/topic и send-state updates, но sending_id не является persistent idempotency key. Текущий адаптер объединяет Updating и Ready; timeout не отменяет native send. Строгая граница live/backlog и exactly-once отправка не гарантированы просмотренными контрактами; отчёт разделяет факты, рекомендации и открытые решения.

Контекст: branch `codex/research/telegram-auto-reply`, commit `20de7847ca642d51a77535e0d76951dd4055f9f1`, isolated clone `/tmp/daevox-auto-reply-research`, файл `.scratch/telegram-auto-reply/research/delivery.md`. Копия отчёта сохранена в основном рабочем дереве по тому же относительному пути; основные git refs не изменялись. Аккаунт не использовался, сообщения не отправлялись, код приложения не менялся.
