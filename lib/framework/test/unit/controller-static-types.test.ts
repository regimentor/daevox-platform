import assert from 'node:assert/strict';
import test from 'node:test';
import { Application } from '../../src/Application.ts';
import { HttpControllerBase } from '../../src/HttpControllerBase.ts';
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
}
void rejectInvalidWebSocketControllers;

class MissingWebSocketEvents extends WebSocketControllerBase {
  static name = 'typed';
}

class InvalidWebSocketEvents extends WebSocketControllerBase {
  static name = 'typed';
  static events = [{ name: 'get', handler: 42 }] as const;
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
};

test('TypeScript проверяет статические поля HTTP- и WebSocket-контроллеров', () => {
  assert.deepEqual(staticContractChecks, {
    validHttp: true,
    missingHttpPrefix: false,
    invalidHttpRoutes: false,
    validWebSocket: true,
    missingWebSocketEvents: false,
    invalidWebSocketEvents: false,
  });
});
