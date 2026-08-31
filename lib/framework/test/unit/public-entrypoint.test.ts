import assert from 'node:assert/strict';
import test from 'node:test';
import * as framework from '@daevox/framework';
import type {
  AppState,
  AppStateInstance,
  Application,
  ApplicationOptions,
  EventListenerBase,
  EventSenderCapability,
  HttpControllerBase,
  HttpControllerClass,
  HttpHandler,
  HttpMiddleware,
  HttpOptions,
  HttpRouteDeclaration,
  JobRunnerCapability,
  WebSocketControllerBase,
  WebSocketControllerClass,
  WebSocketEventDeclaration,
  WebSocketHandler,
  WebSocketMessageMiddleware,
  WebSocketOptions,
  WebSocketSenderCapability,
} from '@daevox/framework';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type HttpJobRunnerIsPublicCapability = Expect<
  Equal<HttpControllerBase['jobRunner'], JobRunnerCapability>
>;
type HttpEventsIsPublicCapability = Expect<
  Equal<HttpControllerBase['events'], EventSenderCapability>
>;
type HttpWebSocketIsPublicCapability = Expect<
  Equal<HttpControllerBase['websocket'], WebSocketSenderCapability>
>;
type WebSocketJobRunnerIsPublicCapability = Expect<
  Equal<WebSocketControllerBase['jobRunner'], JobRunnerCapability>
>;
type WebSocketEventsIsPublicCapability = Expect<
  Equal<WebSocketControllerBase['events'], EventSenderCapability>
>;
type ListenerJobRunnerIsPublicCapability = Expect<
  Equal<EventListenerBase['jobRunner'], JobRunnerCapability>
>;
type ListenerWebSocketIsPublicCapability = Expect<
  Equal<EventListenerBase['websocket'], WebSocketSenderCapability>
>;
type PublicGenericDefaultsRemainCompatible = Expect<
  Equal<
    [
      AppState,
      Application,
      ApplicationOptions,
      HttpControllerClass,
      HttpHandler,
      HttpMiddleware,
      HttpOptions,
      HttpRouteDeclaration,
      WebSocketControllerClass,
      WebSocketEventDeclaration,
      WebSocketHandler,
      WebSocketMessageMiddleware,
      WebSocketOptions,
    ],
    [
      AppState<AppStateInstance>,
      Application<AppStateInstance>,
      ApplicationOptions<AppStateInstance>,
      HttpControllerClass<AppStateInstance>,
      HttpHandler<AppStateInstance>,
      HttpMiddleware<AppStateInstance>,
      HttpOptions<AppStateInstance>,
      HttpRouteDeclaration<AppStateInstance>,
      WebSocketControllerClass<AppStateInstance>,
      WebSocketEventDeclaration<AppStateInstance>,
      WebSocketHandler<AppStateInstance>,
      WebSocketMessageMiddleware<AppStateInstance>,
      WebSocketOptions<AppStateInstance>,
    ]
  >
>;

void (undefined as unknown as HttpJobRunnerIsPublicCapability);
void (undefined as unknown as HttpEventsIsPublicCapability);
void (undefined as unknown as HttpWebSocketIsPublicCapability);
void (undefined as unknown as WebSocketJobRunnerIsPublicCapability);
void (undefined as unknown as WebSocketEventsIsPublicCapability);
void (undefined as unknown as ListenerJobRunnerIsPublicCapability);
void (undefined as unknown as ListenerWebSocketIsPublicCapability);
void (undefined as unknown as PublicGenericDefaultsRemainCompatible);

test('the package entrypoint exposes only the supported runtime interface', () => {
  assert.deepEqual(Object.keys(framework).toSorted(), [
    'Application',
    'ApplicationStateError',
    'DuplicateHttpControllerError',
    'DuplicateWebSocketControllerError',
    'EventDroppedError',
    'EventHandlerTimeoutError',
    'EventListenerBase',
    'EventListenerConflictError',
    'EventQueueFullError',
    'EventSenderClosedError',
    'HttpControllerBase',
    'HttpError',
    'HttpRouteConflictError',
    'InvalidEventListenerError',
    'InvalidEventOptionsError',
    'InvalidEventPushError',
    'InvalidHttpControllerError',
    'InvalidHttpOptionsError',
    'InvalidHttpPathEncodingError',
    'InvalidHttpRouteError',
    'InvalidJobError',
    'InvalidJobOptionsError',
    'InvalidWebSocketControllerError',
    'InvalidWebSocketOptionsError',
    'InvalidWebSocketSendError',
    'Job',
    'JobAbortedError',
    'JobDataCloneError',
    'JobExecutionError',
    'JobQueueFullError',
    'JobRunnerClosedError',
    'JobTimedOutError',
    'MiddlewareExecutionError',
    'WebSocketClientNotFoundError',
    'WebSocketControllerBase',
    'WebSocketControllerConflictError',
    'WebSocketEventError',
    'WebSocketProtocolError',
    'WorkerTerminatedError',
  ]);
});
