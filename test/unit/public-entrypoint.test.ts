import assert from 'node:assert/strict';
import test from 'node:test';
import * as framework from 'daevox-node-framework';
import type {
  EventListenerBase,
  EventSenderCapability,
  HttpControllerBase,
  JobRunnerCapability,
  WebSocketControllerBase,
  WebSocketSenderCapability,
} from 'daevox-node-framework';

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

void (undefined as unknown as HttpJobRunnerIsPublicCapability);
void (undefined as unknown as HttpEventsIsPublicCapability);
void (undefined as unknown as HttpWebSocketIsPublicCapability);
void (undefined as unknown as WebSocketJobRunnerIsPublicCapability);
void (undefined as unknown as WebSocketEventsIsPublicCapability);
void (undefined as unknown as ListenerJobRunnerIsPublicCapability);
void (undefined as unknown as ListenerWebSocketIsPublicCapability);

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
