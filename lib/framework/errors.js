export class InvalidHttpControllerError extends TypeError {}

export class InvalidHttpRouteError extends TypeError {}

export class DuplicateHttpControllerError extends Error {}

export class HttpRouteConflictError extends Error {}

export class InvalidHttpPathEncodingError extends URIError {}

export class InvalidJobError extends TypeError {}

export class InvalidJobOptionsError extends TypeError {}

export class JobDataCloneError extends Error {}

export class JobQueueFullError extends Error {}

export class JobAbortedError extends Error {}

export class JobTimedOutError extends Error {}

export class JobExecutionError extends Error {}

export class WorkerTerminatedError extends Error {}

export class JobRunnerClosedError extends Error {}
