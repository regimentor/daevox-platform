# close после fatal должен ожидать освобождение transport

Type: task
Status: resolved

## Симптом

При реализации telegram-qr-auth прикладной тест `fatal failure releases the old client before permitting an explicit restart` показывает доступный restart до завершения transport.destroy. Это позволяет повторно открыть постоянные каталоги ещё живого клиента.

## Воспроизведение

`node apps/backend/test/telegram.test.ts`: 10 passed, 1 failed; ожидались пустые allowedActions, получен restart до разрешения destroyGate.

## Причина

TdlibClient.fail запускает destroy без ожидания; performClose в failed возвращает сразу. Требуется сохранить Promise освобождения и вернуть его из close. Публичный интерфейс не меняется.

## Answer

Сохранён Promise освобождения после fatal; close ожидает его, в том числе при вызове из onError. Регрессионный тест wrapper и прикладной тест Telegram проходят. TDLib verify, включая native offline smoke, пройден.

Дополнительный регрессионный тест показал, что штатный close также проглатывал ошибку transport.destroy. Теперь Promise close отклоняется при неподтверждённом освобождении; прикладной модуль не разрешает новый клиент в этом случае.
