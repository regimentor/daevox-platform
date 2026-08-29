/**
 * Public runtime entrypoint. Its explicit exports define the supported framework interface.
 * Публичная runtime-точка входа. Её явные экспорты определяют поддерживаемый interface фреймворка.
 */
export { Application } from '../lib/framework/Application.ts';
export { EventListenerBase } from '../lib/framework/EventListenerBase.ts';
export { HttpControllerBase } from '../lib/framework/HttpControllerBase.ts';
export { Job } from '../lib/framework/Job.ts';
export { WebSocketControllerBase } from '../lib/framework/WebSocketControllerBase.ts';
export {
  ApplicationStateError,
  DuplicateHttpControllerError,
  DuplicateWebSocketControllerError,
  EventDroppedError,
  EventHandlerTimeoutError,
  EventListenerConflictError,
  EventQueueFullError,
  EventSenderClosedError,
  HttpError,
  HttpRouteConflictError,
  InvalidEventListenerError,
  InvalidEventOptionsError,
  InvalidEventPushError,
  InvalidHttpControllerError,
  InvalidHttpOptionsError,
  InvalidHttpPathEncodingError,
  InvalidHttpRouteError,
  InvalidJobError,
  InvalidJobOptionsError,
  InvalidWebSocketControllerError,
  InvalidWebSocketOptionsError,
  InvalidWebSocketSendError,
  JobAbortedError,
  JobDataCloneError,
  JobExecutionError,
  JobQueueFullError,
  JobRunnerClosedError,
  JobTimedOutError,
  MiddlewareExecutionError,
  WebSocketClientNotFoundError,
  WebSocketControllerConflictError,
  WebSocketEventError,
  WebSocketProtocolError,
  WorkerTerminatedError,
} from '../lib/framework/errors.ts';

export type {
  ApplicationOptions,
  EventOptions,
  HttpControllerClass,
  HttpMiddleware,
  HttpOptions,
  HttpRequestContext,
  HttpResponse,
  HttpRouteContext,
  HttpRouteDeclaration,
  ListenOptions,
  WebSocketDisconnectContext,
  WebSocketHandlerContext,
  WebSocketLifecycleContext,
  WebSocketMessageMiddleware,
  WebSocketOptions,
} from '../lib/framework/Application.ts';
export type {
  ApplicationEventContext,
  ApplicationEventHandler,
  EventListenerDependencies,
} from '../lib/framework/EventListenerBase.ts';
export type {
  ApplicationEventDataClass,
  ApplicationEventDeclaration,
} from '../lib/framework/EventListenerRegistry.ts';
export type { ApplicationEventAddress } from '../lib/framework/EventSender.ts';
export type { HttpControllerOptions } from '../lib/framework/HttpControllerBase.ts';
export type { JobClass, JobContext, JobRun } from '../lib/framework/Job.ts';
export type { JobRunOptions, JobRunnerConfig } from '../lib/framework/JobRunner.ts';
export type { WebSocketControllerOptions } from '../lib/framework/WebSocketControllerBase.ts';
export type { WebSocketEventDeclaration } from '../lib/framework/WebSocketControllerRegistry.ts';
export type {
  WebSocketSendMessage,
  WebSocketSendResult,
  WebSocketSendTarget,
} from '../lib/framework/WebSocketSender.ts';
export type {
  EventSenderCapability,
  JobRunnerCapability,
  WebSocketSenderCapability,
} from '../lib/framework/capabilities.ts';
export type {
  HttpErrorResponse,
  WebSocketProtocolErrorCode,
  WebSocketProtocolErrorOptions,
} from '../lib/framework/errors.ts';
