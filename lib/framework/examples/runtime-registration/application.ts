import {
  Application,
  EventListenerBase,
  HttpControllerBase,
  WebSocketControllerBase,
} from '@daevox/framework';
import { ExampleAppState } from '../ExampleAppState.ts';

/** DTO delivered to the runtime listener. / DTO, доставляемый runtime listener. */
export class RuntimeEvent {
  readonly message: string;

  constructor(message: string) {
    this.message = message;
  }
}

/** HTTP route that sends an event to the runtime listener. / HTTP-маршрут, отправляющий событие runtime listener. */
class TriggerController extends HttpControllerBase {
  static prefix = '/runtime';
  static routes = [
    { method: 'POST', path: '/register', handler: 'register' },
    { method: 'POST', path: '/event', handler: 'trigger' },
  ] as const;

  register(_appState: ExampleAppState) {
    registerRuntimeResources();
    return { status: 201, body: { registered: true } };
  }

  trigger() {
    this.events.push(
      { listener: 'runtime-audit', event: 'received' },
      new RuntimeEvent('event delivered after runtime registration'),
    );
    return { status: 202, body: { accepted: true } };
  }
}

/** Runtime HTTP resource. / Runtime HTTP-ресурс. */
export class RuntimeHttpController extends HttpControllerBase {
  static prefix = '/runtime';
  static routes = [{ method: 'GET', path: '/status', handler: 'status' }] as const;

  status() {
    return { status: 200, body: { resource: 'http', registered: 'runtime' } };
  }
}

/** Runtime WebSocket resource. / Runtime WebSocket-ресурс. */
export class RuntimeWebSocketController extends WebSocketControllerBase {
  static name = 'runtime';
  static events = [{ name: 'ping', handler: 'ping' }] as const;

  ping() {
    return { resource: 'websocket', registered: 'runtime' };
  }
}

/** Runtime event resource. / Runtime event-ресурс. */
export class RuntimeAuditListener extends EventListenerBase {
  static name = 'runtime-audit';
  static events = [{ name: 'received', data: RuntimeEvent, handler: 'received' }] as const;

  received(_appState: ExampleAppState, event: RuntimeEvent) {
    runtimeEvents.push(event.message);
  }
}

/** Observed event messages for the runnable example. / Наблюдаемые сообщения runnable-примера. */
export const runtimeEvents: string[] = [];

let runtimeApplication: Application<ExampleAppState> | undefined;

/** Creates an application with one startup resource. / Создаёт приложение с одним startup-ресурсом. */
export function createRuntimeRegistrationApplication() {
  const application = new Application({ appState: ExampleAppState });
  application.registerHttpController(TriggerController);
  runtimeApplication = application;
  return application;
}

/** Publishes all resources after startup. / Публикует все ресурсы после запуска. */
export function registerRuntimeResources() {
  if (!runtimeApplication) throw new Error('Runtime example application is not initialized');
  const application = runtimeApplication;
  application
    .registerRuntimeHttpController(RuntimeHttpController)
    .registerRuntimeWebSocketController(RuntimeWebSocketController)
    .registerRuntimeEventListener(RuntimeAuditListener);
  return application;
}
