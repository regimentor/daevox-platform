import assert from 'node:assert/strict';
import test from 'node:test';
import { Application } from '../../src/Application.ts';
import { EventListenerBase } from '../../src/EventListenerBase.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';
import type {
  ApplicationEventContext,
  ApplicationEventHandler,
  ByteSize,
  EventListenerClass,
  HttpHandler,
  HttpRequestBodyErrorCode,
  HttpRequestBodyReader,
} from '../../src/index.ts';
import type {
  AppStateInstance,
  HttpControllerClass,
  HttpMiddleware,
  HttpRequestContext,
  HttpResponse,
  WebSocketHandlerContext,
} from '../../src/Application.ts';
import { WebSocketControllerBase } from '../../src/WebSocketControllerBase.ts';
import type { WebSocketControllerClass } from '../../src/WebSocketControllerRegistry.ts';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

class ConcreteAppState {
  getSubject() {
    return 'subject';
  }
}

const inferredApplication = new Application({ appState: ConcreteAppState });
type ApplicationKeepsConcreteState = Expect<
  Equal<typeof inferredApplication, Application<ConcreteAppState>>
>;

const concreteMiddleware: HttpMiddleware<ConcreteAppState> = (appState, _context, next) => {
  appState.getSubject();
  return next();
};

void (undefined as unknown as ApplicationKeepsConcreteState);
void concreteMiddleware;

interface CreateUserBody {
  readonly name: string;
}

interface CreateUserState {
  subject?: string;
}

const typedBodyContext = undefined as unknown as HttpRequestContext<
  CreateUserBody,
  CreateUserState
>;
type JsonBodyPropagates = Expect<
  Equal<ReturnType<typeof typedBodyContext.requestBody.json>, Promise<CreateUserBody>>
>;
function verifyTypedBodyContext() {
  typedBodyContext.state.subject = 'subject';
  // @ts-expect-error JSON type is fixed on HttpRequestContext
  typedBodyContext.requestBody.json<string>();
  // @ts-expect-error the eager compatibility property was removed
  void typedBodyContext.body;
}
void verifyTypedBodyContext;
void (undefined as unknown as JsonBodyPropagates);

const typedHttpHandler: HttpHandler<ConcreteAppState, CreateUserBody, CreateUserState> = async (
  appState,
  context,
) => ({
  status: 200,
  body: { subject: appState.getSubject(), input: await context.requestBody.json() },
});
void typedHttpHandler;

const bodyReader = undefined as unknown as HttpRequestBodyReader<CreateUserBody>;
const bodyErrorCode = undefined as unknown as HttpRequestBodyErrorCode;
void bodyReader;
void bodyErrorCode;

const validByteSizes = ['0B', '1kb', '2MiB', '3GIB'] as const satisfies readonly ByteSize[];
// @ts-expect-error ByteSize requires a unit
const missingByteSizeUnit: ByteSize = '100';
// @ts-expect-error ByteSize rejects unknown units
const unknownByteSizeUnit: ByteSize = '1XB';
void validByteSizes;
void missingByteSizeUnit;
void unknownByteSizeUnit;

class TypedHttpController extends HttpControllerBase {
  static prefix = '/typed-state';
  static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;

  get(appState: ConcreteAppState, _context: HttpRequestContext) {
    return { status: 200, body: { subject: appState.getSubject() } };
  }
}

class MissingHttpHandler extends HttpControllerBase {
  static prefix = '/missing';
  static routes = [{ method: 'GET', path: '/', handler: 'missing' }] as const;
}

class WrongHttpState extends HttpControllerBase {
  static prefix = '/wrong-state';
  static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;

  get(_appState: { other: true }, _context: HttpRequestContext) {
    return { status: 200 };
  }
}

class WrongHttpContext extends HttpControllerBase {
  static prefix = '/wrong-context';
  static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;

  get(_appState: ConcreteAppState, _context: string) {
    return { status: 200 };
  }
}

class WrongHttpResult extends HttpControllerBase {
  static prefix = '/wrong-result';
  static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;

  get(_appState: ConcreteAppState, _context: HttpRequestContext) {
    return 'not an HTTP response';
  }
}

class WidenedHttpRoutes extends HttpControllerBase {
  static prefix = '/widened';
  static routes = [{ method: 'GET', path: '/', handler: 'get' }];

  get(_appState: ConcreteAppState, _context: HttpRequestContext) {
    return { status: 200 };
  }
}

inferredApplication.registerHttpController(TypedHttpController);

function acceptValidRuntimeHttpControllers() {
  inferredApplication.registerRuntimeHttpController(TypedHttpController);
}
void acceptValidRuntimeHttpControllers;

function rejectInvalidHttpControllers() {
  // @ts-expect-error handler name must identify an instance method
  inferredApplication.registerHttpController(MissingHttpHandler);
  // @ts-expect-error handler AppState must match the Application AppState
  inferredApplication.registerHttpController(WrongHttpState);
  // @ts-expect-error handler context must match the HTTP transport contract
  inferredApplication.registerHttpController(WrongHttpContext);
  // @ts-expect-error handler result must match the HTTP transport contract
  inferredApplication.registerHttpController(WrongHttpResult);
  // @ts-expect-error handler names require literal route metadata declared with as const
  inferredApplication.registerHttpController(WidenedHttpRoutes);
  // @ts-expect-error runtime registration preserves the handler proof
  inferredApplication.registerRuntimeHttpController(WrongHttpResult);
}
void rejectInvalidHttpControllers;

const sharedMiddleware: HttpMiddleware<AppStateInstance> = (_state, _context, next) => next();
const fullyTypedApplication = new Application({
  appState: ConcreteAppState,
  http: {
    middleware: [sharedMiddleware],
    onError(appState) {
      appState.getSubject();
    },
  },
  websocket: {
    middleware: [
      (appState, _context, next) => {
        appState.getSubject();
        return next();
      },
    ],
    onConnect(appState) {
      appState.getSubject();
    },
    onDisconnect(appState) {
      appState.getSubject();
    },
    onError(appState) {
      appState.getSubject();
    },
  },
});
void fullyTypedApplication;

class ValidHttpController extends HttpControllerBase {
  static prefix = '/typed';
  static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;

  get(_appState: AppStateInstance, _context: HttpRequestContext): HttpResponse {
    return { status: 200 };
  }
}

class MissingHttpPrefix extends HttpControllerBase {
  static routes = [{ method: 'GET', path: '/', handler: 'get' }] as const;

  get() {}
}

class InvalidHttpRoutes extends HttpControllerBase {
  static prefix = '/typed';
  static routes = [{ method: 'GET', path: '/', handler: 42 }] as const;
}

class ValidWebSocketController extends WebSocketControllerBase {
  static name = 'typed';
  static events = [{ name: 'get', handler: 'get' }] as const;

  get(_appState: AppStateInstance, _context: WebSocketHandlerContext) {
    return undefined;
  }
}

class TypedWebSocketController extends WebSocketControllerBase {
  static name = 'typed-state';
  static events = [{ name: 'get', handler: 'get' }] as const;

  get(appState: ConcreteAppState, _context: WebSocketHandlerContext) {
    return { subject: appState.getSubject() };
  }
}

class MissingWebSocketHandler extends WebSocketControllerBase {
  static name = 'missing';
  static events = [{ name: 'get', handler: 'missing' }] as const;
}

class WrongWebSocketState extends WebSocketControllerBase {
  static name = 'wrong-state';
  static events = [{ name: 'get', handler: 'get' }] as const;

  get(_appState: { other: true }, _context: WebSocketHandlerContext) {
    return undefined;
  }
}

class WrongWebSocketContext extends WebSocketControllerBase {
  static name = 'wrong-context';
  static events = [{ name: 'get', handler: 'get' }] as const;

  get(_appState: ConcreteAppState, _context: string) {
    return undefined;
  }
}

class WrongWebSocketResult extends WebSocketControllerBase {
  static name = 'wrong-result';
  static events = [{ name: 'get', handler: 'get' }] as const;

  get(_appState: ConcreteAppState, _context: WebSocketHandlerContext) {
    return 'not an object';
  }
}

class WidenedWebSocketEvents extends WebSocketControllerBase {
  static name = 'widened';
  static events = [{ name: 'get', handler: 'get' }];

  get(_appState: ConcreteAppState, _context: WebSocketHandlerContext) {
    return undefined;
  }
}

inferredApplication.registerWebSocketController(TypedWebSocketController);

function acceptValidRuntimeWebSocketControllers() {
  inferredApplication.registerRuntimeWebSocketController(TypedWebSocketController);
}
void acceptValidRuntimeWebSocketControllers;

function rejectInvalidWebSocketControllers() {
  // @ts-expect-error handler name must identify an instance method
  inferredApplication.registerWebSocketController(MissingWebSocketHandler);
  // @ts-expect-error handler AppState must match the Application AppState
  inferredApplication.registerWebSocketController(WrongWebSocketState);
  // @ts-expect-error handler context must match the WebSocket transport contract
  inferredApplication.registerWebSocketController(WrongWebSocketContext);
  // @ts-expect-error handler result must match the WebSocket transport contract
  inferredApplication.registerWebSocketController(WrongWebSocketResult);
  // @ts-expect-error handler names require literal event metadata declared with as const
  inferredApplication.registerWebSocketController(WidenedWebSocketEvents);
  // @ts-expect-error runtime registration preserves the handler proof
  inferredApplication.registerRuntimeWebSocketController(WrongWebSocketContext);
}
void rejectInvalidWebSocketControllers;

class CreatedEvent {
  readonly id = 'created';
}

const typedApplicationEventHandler: ApplicationEventHandler<CreatedEvent, ConcreteAppState> = (
  appState,
  data,
  context,
) => ({ subject: appState.getSubject(), id: data.id, aborted: context.signal.aborted });
void typedApplicationEventHandler;

class OtherEvent {
  readonly other = true;
}

class TypedEventListener extends EventListenerBase {
  static name = 'typed-events';
  static events = [{ name: 'created', data: CreatedEvent, handler: 'created' }] as const;

  created(appState: ConcreteAppState, data: CreatedEvent, _context: ApplicationEventContext) {
    return { subject: appState.getSubject(), id: data.id };
  }
}

class MissingEventHandler extends EventListenerBase {
  static name = 'missing-event-handler';
  static events = [{ name: 'created', data: CreatedEvent, handler: 'missing' }] as const;
}

class WrongEventState extends EventListenerBase {
  static name = 'wrong-event-state';
  static events = [{ name: 'created', data: CreatedEvent, handler: 'created' }] as const;

  created(_appState: { other: true }, _data: CreatedEvent, _context: ApplicationEventContext) {}
}

class WrongEventData extends EventListenerBase {
  static name = 'wrong-event-data';
  static events = [{ name: 'created', data: CreatedEvent, handler: 'created' }] as const;

  created(_appState: ConcreteAppState, _data: OtherEvent, _context: ApplicationEventContext) {}
}

class WrongEventContext extends EventListenerBase {
  static name = 'wrong-event-context';
  static events = [{ name: 'created', data: CreatedEvent, handler: 'created' }] as const;

  created(_appState: ConcreteAppState, _data: CreatedEvent, _context: string) {}
}

class WidenedListenerEvents extends EventListenerBase {
  static name = 'widened-listener-events';
  static events = [{ name: 'created', data: CreatedEvent, handler: 'created' }];

  created(_appState: ConcreteAppState, _data: CreatedEvent, _context: ApplicationEventContext) {}
}

inferredApplication.registerEventListener(TypedEventListener);

function acceptValidRuntimeEventListeners() {
  inferredApplication.registerRuntimeEventListener(TypedEventListener);
}
void acceptValidRuntimeEventListeners;

function rejectInvalidEventListeners() {
  // @ts-expect-error handler name must identify an instance method
  inferredApplication.registerEventListener(MissingEventHandler);
  // @ts-expect-error handler AppState must match the Application AppState
  inferredApplication.registerEventListener(WrongEventState);
  // @ts-expect-error handler data must match the declared DTO class
  inferredApplication.registerEventListener(WrongEventData);
  // @ts-expect-error handler context must match the application-event contract
  inferredApplication.registerEventListener(WrongEventContext);
  // @ts-expect-error handler names require literal event metadata declared with as const
  inferredApplication.registerEventListener(WidenedListenerEvents);
  // @ts-expect-error runtime registration preserves the handler proof
  inferredApplication.registerRuntimeEventListener(WrongEventData);
}
void rejectInvalidEventListeners;

class MissingWebSocketEvents extends WebSocketControllerBase {
  static name = 'typed';
}

class InvalidWebSocketEvents extends WebSocketControllerBase {
  static name = 'typed';
  static events = [{ name: 'get', handler: 42 }] as const;
}

class MissingListenerEvents extends EventListenerBase {
  static name = 'missing-listener-events';
}

class InvalidListenerEvents extends EventListenerBase {
  static name = 'invalid-listener-events';
  static events = [{ name: 'created', data: 42, handler: 'created' }] as const;

  created() {}
}

const staticContractChecks = {
  validHttp: true satisfies typeof ValidHttpController extends HttpControllerClass ? true : false,
  missingHttpPrefix: false satisfies typeof MissingHttpPrefix extends HttpControllerClass
    ? true
    : false,
  invalidHttpRoutes: false satisfies typeof InvalidHttpRoutes extends HttpControllerClass
    ? true
    : false,
  validWebSocket: true satisfies typeof ValidWebSocketController extends WebSocketControllerClass
    ? true
    : false,
  missingWebSocketEvents:
    false satisfies typeof MissingWebSocketEvents extends WebSocketControllerClass ? true : false,
  invalidWebSocketEvents:
    false satisfies typeof InvalidWebSocketEvents extends WebSocketControllerClass ? true : false,
  validEventListener:
    true satisfies typeof TypedEventListener extends EventListenerClass<ConcreteAppState>
      ? true
      : false,
  missingListenerEvents:
    false satisfies typeof MissingListenerEvents extends EventListenerClass<ConcreteAppState>
      ? true
      : false,
  invalidListenerEvents:
    false satisfies typeof InvalidListenerEvents extends EventListenerClass<ConcreteAppState>
      ? true
      : false,
};

test('TypeScript проверяет статические поля контроллеров и listener', () => {
  assert.deepEqual(staticContractChecks, {
    validHttp: true,
    missingHttpPrefix: false,
    invalidHttpRoutes: false,
    validWebSocket: true,
    missingWebSocketEvents: false,
    invalidWebSocketEvents: false,
    validEventListener: true,
    missingListenerEvents: false,
    invalidListenerEvents: false,
  });
});
