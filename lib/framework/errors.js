export class InvalidHttpControllerError extends TypeError {}

export class InvalidHttpRouteError extends TypeError {}

export class DuplicateHttpControllerError extends Error {}

export class HttpRouteConflictError extends Error {}

export class InvalidHttpPathEncodingError extends URIError {}

export class InvalidHttpOptionsError extends TypeError {}

export class InvalidWebSocketControllerError extends TypeError {}

export class InvalidWebSocketOptionsError extends TypeError {}

export class DuplicateWebSocketControllerError extends Error {}

export class WebSocketControllerConflictError extends Error {}

export class WebSocketProtocolError extends Error {
  constructor(code, { fatal = false, controller, event } = {}) {
    super(code);
    this.code = code;
    this.fatal = fatal;
    this.controller = controller;
    this.event = event;
  }
}

export class ApplicationStateError extends Error {}

export class HttpError extends Error {
  constructor(status, response = {}, options) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new TypeError('HttpError status must be an integer from 400 to 599');
    }
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      throw new TypeError('HttpError response must be an object');
    }
    const keys = Reflect.ownKeys(response);
    if (keys.some((key) => typeof key !== 'string' || !['headers', 'body'].includes(key))) {
      throw new TypeError('HttpError response contains an unknown field');
    }
    if (response.headers !== undefined && !(response.headers instanceof Headers)) {
      throw new TypeError('HttpError headers must be Headers');
    }
    for (const name of ['content-length', 'transfer-encoding', 'connection']) {
      if (response.headers?.has(name)) throw new TypeError(`HttpError cannot set ${name}`);
    }
    if (
      response.body !== undefined &&
      typeof response.body !== 'string' &&
      !Buffer.isBuffer(response.body) &&
      !(response.body instanceof Uint8Array)
    ) {
      let json;
      try {
        json = JSON.stringify(response.body);
      } catch (cause) {
        throw new TypeError('HttpError body is not JSON-compatible', { cause });
      }
      if (json === undefined) throw new TypeError('HttpError body has no JSON representation');
    }
    super(`HTTP ${status}`, options);
    this.status = status;
    this.headers = response.headers;
    this.body = response.body;
  }
}

export class InvalidJobError extends TypeError {}

export class InvalidJobOptionsError extends TypeError {}

export class JobDataCloneError extends Error {}

export class JobQueueFullError extends Error {}

export class JobAbortedError extends Error {}

export class JobTimedOutError extends Error {}

export class JobExecutionError extends Error {}

export class WorkerTerminatedError extends Error {}

export class JobRunnerClosedError extends Error {}
