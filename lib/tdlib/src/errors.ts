/** Error returned by TDLib's JSON API. / Ошибка, возвращённая JSON API TDLib. @public */
export class TdlibError extends Error {
  /** Original TDLib numeric error code. / Исходный числовой код ошибки TDLib. @public */
  readonly code: number;

  /** Creates a TDLib error while preserving its native code and message. / Создаёт ошибку TDLib, сохраняя исходные код и сообщение. @public */
  constructor(code: number, message: string) {
    super(message);
    this.name = 'TdlibError';
    this.code = code;
  }
}

/** Error raised when a client operation is used in an invalid lifecycle state. / Ошибка неверного состояния жизненного цикла клиента. @public */
export class TdlibLifecycleError extends Error {
  /** Creates a lifecycle error. / Создаёт ошибку жизненного цикла. @public */
  constructor(message: string) {
    super(message);
    this.name = 'TdlibLifecycleError';
  }
}

/** Error raised when the native TDLib artifact is absent or does not match the source schema. / Ошибка отсутствующего или несовместимого native-артефакта TDLib. @public */
export class TdlibArtifactError extends Error {
  /** Creates an artifact error. / Создаёт ошибку артефакта. @public */
  constructor(message: string) {
    super(message);
    this.name = 'TdlibArtifactError';
  }
}

/** Error raised when an update subscription cannot keep its ordered queue. / Ошибка переполнения очереди подписки обновлений. @public */
export class TdlibUpdateQueueFullError extends Error {
  /** Creates a queue overflow error. / Создаёт ошибку переполнения очереди. @public */
  constructor(subscriptionId: number, limit: number) {
    super(`TDLib update subscription ${subscriptionId} exceeded its queue limit of ${limit}`);
    this.name = 'TdlibUpdateQueueFullError';
  }
}

/** Error event emitted when a subscription handler fails. / Событие ошибки обработчика подписки. @public */
export interface TdlibSubscriptionError {
  readonly subscriptionId: number;
  readonly error: unknown;
}
