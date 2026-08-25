# Фоновые задачи

Фоновые задачи выносят работу из event loop в переиспользуемые потоки Worker. Это подходит для
CPU-intensive вычислений и изолированной работы; быстрый асинхронный I/O обычно проще выполнить
непосредственно в HTTP- или WebSocket-обработчике.

## Объявление задачи

Каждая задача находится в отдельном ESM-модуле, напрямую наследует `Job`, экспортируется по
умолчанию, объявляет собственный `metaUrl` и собственный метод `run`:

```js
import { Job } from 'daevox-node-framework/lib/framework/Job.js';

export default class SumJob extends Job {
  static metaUrl = import.meta.url;

  run({ values }, { signal }) {
    signal.throwIfAborted();
    return { sum: values.reduce((total, value) => total + value, 0) };
  }
}
```

Worker динамически импортирует модуль по `metaUrl` и заново проверяет тот же контракт. Не меняйте
`metaUrl` и не используйте re-export вместо default export класса.

## Запуск из контроллера

HTTP- и WebSocket-контроллеры получают принадлежащий приложению исполнитель задач как
`this.jobRunner`:

```js
const result = await this.jobRunner.run(SumJob, ctx.body, {
  signal: ctx.signal,
  timeout: 5_000,
});
```

`payload` клонируется до постановки в очередь, результат клонируется при возврате из Worker.
Используйте значения, совместимые с алгоритмом structured clone. Transferable-объекты не
поддерживаются. Изменения исходного объекта после `run()` не видны задаче.

`signal` отменяет ожидающую или активную задачу. Активная задача получает отменённый
`context.signal`; если она не завершится за `terminationGracePeriod`, Worker принудительно
останавливается. `timeout: 0` немедленно отклоняет запуск. Явный `timeout` переопределяет
`jobs.defaultTimeout`.

## Очередь и Worker Pool

Worker создаются лениво до `poolSize`, затем задачи попадают в FIFO-очередь. `queueSize` ограничивает
только ожидающие задачи; при переполнении запуск отклоняется `JobQueueFullError`. После завершения
Worker переиспользуется.

При `Application.close()` ожидающие задачи отменяются сразу. Активные задачи могут завершиться в
пределах `jobs.shutdownTimeout`, после чего оставшиеся Worker останавливаются.

## Обработка ошибок

```js
import {
  JobAbortedError,
  JobExecutionError,
  JobQueueFullError,
  JobTimedOutError,
} from 'daevox-node-framework/lib/framework/errors.js';

try {
  return await this.jobRunner.run(SumJob, payload, { signal, timeout: 5_000 });
} catch (error) {
  if (error instanceof JobQueueFullError) {
    // Верните 503 или примените admission control.
  }
  if (error instanceof JobTimedOutError || error instanceof JobAbortedError) {
    // Операция больше не должна продолжаться.
  }
  if (error instanceof JobExecutionError) {
    console.error(error.cause);
  }
  throw error;
}
```

Полный перечень ошибок находится в [разделе диагностики](errors.md#фоновые-задачи).
