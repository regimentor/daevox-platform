import assert from 'node:assert/strict';
import { Application } from 'daevox-node-framework/lib/framework/Application.js';
import { HttpControllerBase } from 'daevox-node-framework/lib/framework/HttpControllerBase.js';
import { EventListenerBase } from 'daevox-node-framework/lib/framework/EventListenerBase.js';
import { Job } from 'daevox-node-framework/lib/framework/Job.js';
import { WebSocketControllerBase } from 'daevox-node-framework/lib/framework/WebSocketControllerBase.js';
import {
  HttpError,
  EventDroppedError,
  EventHandlerTimeoutError,
  EventListenerConflictError,
  EventQueueFullError,
  EventSenderClosedError,
  InvalidEventListenerError,
  InvalidEventOptionsError,
  InvalidEventPushError,
  MiddlewareExecutionError,
  WebSocketEventError,
  WebSocketProtocolError,
} from 'daevox-node-framework/lib/framework/errors.js';

for (const publicClass of [
  Application,
  EventListenerBase,
  HttpControllerBase,
  Job,
  WebSocketControllerBase,
  HttpError,
  EventDroppedError,
  EventHandlerTimeoutError,
  EventListenerConflictError,
  EventQueueFullError,
  EventSenderClosedError,
  InvalidEventListenerError,
  InvalidEventOptionsError,
  InvalidEventPushError,
  MiddlewareExecutionError,
  WebSocketEventError,
  WebSocketProtocolError,
]) {
  assert.equal(typeof publicClass, 'function');
}
