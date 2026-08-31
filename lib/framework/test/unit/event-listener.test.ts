class TestAppState {
  readonly marker = undefined;
}
import assert from 'node:assert/strict';
import test from 'node:test';

// oxlint-disable typescript/no-extraneous-class -- DTO classes intentionally provide nominal identity.
import { Application } from '../../src/Application.ts';
import { EventListenerBase } from '../../src/EventListenerBase.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';
import {
  ApplicationStateError,
  EventDroppedError,
  EventHandlerTimeoutError,
  EventListenerConflictError,
  EventQueueFullError,
  EventSenderClosedError,
  InvalidEventListenerError,
  InvalidEventOptionsError,
  InvalidEventPushError,
} from '../../src/errors.ts';

test('EventListenerBase нельзя создать напрямую', () => {
  assert.throws(() => new EventListenerBase(), InvalidEventListenerError);
});

test('EventListenerBase предоставляет listener ровно jobRunner и websocket', () => {
  class Listener extends EventListenerBase {}
  const jobRunner = { run() {}, close() {} };
  const websocket = { send() {} };
  const listener = new Listener({ jobRunner, websocket } as any);

  assert.deepEqual(Object.keys(listener), ['jobRunner', 'websocket']);
  assert.equal(listener.jobRunner, jobRunner);
  assert.equal(listener.websocket, websocket);
  assert.equal('events' in listener, false);
  assert.throws(() => {
    (listener as any).websocket = undefined;
  }, TypeError);
  for (const value of [undefined, null, {}, { jobRunner }, { jobRunner, websocket, extra: true }]) {
    assert.throws(() => new Listener(value as any), InvalidEventListenerError);
  }
});

test('Application регистрирует корректный EventListener до запуска', async (t: any) => {
  class Created {}
  class AuditListener extends EventListenerBase {
    static name = 'audit';
    static events = [{ name: 'Created', data: Created, handler: 'created' }] as const;
    created() {}
  }

  const application = new Application({ appState: TestAppState });
  t.after(() => application.close());

  assert.equal(application.registerEventListener(AuditListener), application);
});

test('registerEventListener отклоняет классы вне строгого публичного контракта', async () => {
  class Data {}
  class IndirectBase extends EventListenerBase {}
  class Valid extends EventListenerBase {
    static name = 'valid';
    static events = [{ name: 'created', data: Data, handler: 'created' }] as const;
    created() {}
  }
  const invalid = [
    undefined,
    EventListenerBase,
    class Indirect extends IndirectBase {
      static name = 'indirect';
      static events = [{ name: 'created', data: Data, handler: 'created' }] as const;
      created() {}
    },
    class MissingName extends EventListenerBase {
      static events = Valid.events;
      created() {}
    },
    class EmptyEvents extends EventListenerBase {
      static name = 'empty';
      static events = [] as const;
    },
    class BadName extends EventListenerBase {
      static name = 'bad name';
      static events = Valid.events;
      created() {}
    },
    class ExtraField extends EventListenerBase {
      static name = 'extra';
      static events = [{ name: 'created', data: Data, handler: 'created', extra: true }] as const;
      created() {}
    },
    class InvalidEventName extends EventListenerBase {
      static name = 'invalid-event-name';
      static events = [{ name: 'bad name', data: Data, handler: 'created' }] as const;
      created() {}
    },
    class NonStringEventName extends EventListenerBase {
      static name = 'non-string-event-name';
      static events = [{ name: 42, data: Data, handler: 'created' }] as const;
      created() {}
    },
    class EmptyHandlerName extends EventListenerBase {
      static name = 'empty-handler-name';
      static events = [{ name: 'created', data: Data, handler: '' }] as const;
    },
    class ConstructorHandlerName extends EventListenerBase {
      static name = 'constructor-handler-name';
      static events = [{ name: 'created', data: Data, handler: 'constructor' }] as const;
    },
    class NonStringHandlerName extends EventListenerBase {
      static name = 'non-string-handler-name';
      static events = [{ name: 'created', data: Data, handler: 42 }] as const;
    },
    class MissingHandler extends EventListenerBase {
      static name = 'missing-handler';
      static events = [{ name: 'created', data: Data, handler: 'created' }] as const;
    },
    class SparseEvents extends EventListenerBase {
      static name = 'sparse';
      static events = Array(1);
      created() {}
    },
    class AccessorDeclaration extends EventListenerBase {
      static name = 'accessor';
      static events = [
        Object.defineProperties(
          {},
          {
            name: { get: () => 'created', enumerable: true },
            data: { value: Data, enumerable: true },
            handler: { value: 'created', enumerable: true },
          },
        ),
      ] as const;
      created() {}
    },
    class SymbolDeclaration extends EventListenerBase {
      static name = 'symbol';
      static events = [
        { name: 'created', data: Data, handler: 'created', [Symbol('extra')]: true },
      ] as const;
      created() {}
    },
    class InheritedDeclaration extends EventListenerBase {
      static name = 'inherited';
      static events = [
        Object.assign(Object.create({ extra: true }), {
          name: 'created',
          data: Data,
          handler: 'created',
        }),
      ] as const;
      created() {}
    },
    class NonConstructableData extends EventListenerBase {
      static name = 'non-constructable';
      static events = [{ name: 'created', data: () => {}, handler: 'created' }] as const;
      created() {}
    },
  ];

  for (const candidate of invalid) {
    const application = new Application({ appState: TestAppState });
    assert.throws(() => application.registerEventListener(candidate), InvalidEventListenerError);
    await application.close();
  }
});

test('registerEventListener атомарно отклоняет повтор класса, имени и адреса', async (t: any) => {
  class Data {}
  class First extends EventListenerBase {
    static name = 'shared';
    static events = [{ name: 'created', data: Data, handler: 'created' }] as const;
    created() {}
  }
  class SameName extends EventListenerBase {
    static name = 'shared';
    static events = [{ name: 'other', data: Data, handler: 'other' }] as const;
    other() {}
  }
  class DuplicateAddress extends EventListenerBase {
    static name = 'duplicate-address';
    static events = [
      { name: 'created', data: Data, handler: 'created' },
      { name: 'created', data: Data, handler: 'created' },
    ] as const;
    created() {}
  }
  const application = new Application({ appState: TestAppState });
  t.after(() => application.close());

  application.registerEventListener(First);
  (First as any).events = [];
  assert.throws(() => application.registerEventListener(First), EventListenerConflictError);
  assert.throws(() => application.registerEventListener(SameName), EventListenerConflictError);
  assert.throws(
    () => application.registerEventListener(DuplicateAddress),
    EventListenerConflictError,
  );
});

test('registerEventListener запрещён после начала listen', async (t: any) => {
  class Data {}
  class Late extends EventListenerBase {
    static name = 'late';
    static events = [{ name: 'event', data: Data, handler: 'event' }] as const;
    event() {}
  }
  const application = new Application({ appState: TestAppState });
  t.after(() => application.close());
  await application.listen({ port: 0 });

  assert.throws(() => application.registerEventListener(Late), ApplicationStateError);
});

test('Application строго проверяет секцию events', () => {
  const invalidSections = [
    null,
    [],
    { unknown: true },
    { queueSize: 0 },
    { queueSize: Number.MAX_SAFE_INTEGER + 1 },
    { handlerTimeout: 0 },
    { handlerTimeout: Infinity },
    { shutdownTimeout: 0 },
    { shutdownTimeout: 1.5 },
    { onError: true },
  ];

  for (const events of invalidSections) {
    assert.throws(
      () => new Application({ appState: TestAppState, events } as any),
      InvalidEventOptionsError,
    );
  }
});

test('публичные event errors доступны как отдельные классы', () => {
  for (const ErrorClass of [
    InvalidEventOptionsError,
    InvalidEventListenerError,
    EventListenerConflictError,
    InvalidEventPushError,
    EventQueueFullError,
    EventSenderClosedError,
    EventHandlerTimeoutError,
    EventDroppedError,
  ]) {
    assert.ok(new ErrorClass('test') instanceof ErrorClass);
    assert.ok(new ErrorClass('test') instanceof Error);
  }
});

test('HTTP-контроллер fire-and-forget передаёт исходный DTO адресованному listener', async (t: any) => {
  let releaseHandler: any;
  const handlerGate = new Promise<any>((resolve: any) => {
    releaseHandler = resolve;
  });
  let received: any;
  let handlerStarted: any;
  const started = new Promise<any>((resolve: any) => {
    handlerStarted = resolve;
  });

  class Created {
    declare id: any;

    constructor(id: any) {
      this.id = id;
    }
  }
  class AuditListener extends EventListenerBase {
    static name = 'audit';
    static events = [{ name: 'created', data: Created, handler: 'created' }] as const;
    async created(data: any) {
      received = data;
      handlerStarted();
      await handlerGate;
    }
  }
  class OrdersController extends HttpControllerBase {
    static prefix = '/orders';
    static routes = [{ method: 'POST', path: '/', handler: 'create' }] as const;
    create() {
      const event = new Created('order-1');
      const pushResult = this.events.push({ listener: 'audit', event: 'created' }, event);
      return { status: 202, body: { accepted: pushResult === undefined } };
    }
  }

  const application = new Application({ appState: TestAppState });
  t.after(async () => {
    releaseHandler();
    await application.close();
  });
  application.registerEventListener(AuditListener);
  application.registerHttpController(OrdersController);
  const address = await application.listen({ port: 0 });

  const response = await fetch(`http://${address.address}:${address.port}/orders`, {
    method: 'POST',
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  await started;
  assert.ok(received instanceof Created);
  assert.equal(received.id, 'order-1');
});
