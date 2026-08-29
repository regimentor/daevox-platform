import type { ApplicationEventAddress } from './EventSender.ts';
import type { JobClass } from './Job.ts';
import type { JobRunOptions } from './JobRunner.ts';
import type {
  WebSocketSendMessage,
  WebSocketSendResult,
  WebSocketSendTarget,
} from './WebSocketSender.ts';

/**
 * Application-owned background-job capability injected as `jobRunner`.
 * Принадлежащая приложению возможность фоновых задач, внедряемая как `jobRunner`.
 * @public
 */
export interface JobRunnerCapability {
  /**
   * Runs a validated job in the application worker pool.
   * Выполняет проверенную задачу в пуле Worker приложения.
   * @param JobClass Direct job subclass. / Прямой подкласс задачи.
   * @param payload Structured-clone-compatible input. / Входные данные для structured clone.
   * @param options Cancellation and timeout. / Отмена и тайм-аут.
   * @returns Job result. / Результат задачи.
   * @public
   */
  readonly run: <Payload = undefined, Result = unknown>(
    JobClass: JobClass<Payload, Result>,
    payload?: Payload,
    options?: JobRunOptions,
  ) => Promise<Result>;

  /**
   * Stops the shared application job pool.
   * Останавливает общий пул задач приложения.
   * @returns Shutdown completion. / Завершение остановки.
   * @public
   */
  readonly close: () => Promise<void>;
}

/**
 * Addressed application-event capability injected as `events`.
 * Возможность адресуемых событий приложения, внедряемая как `events`.
 * @public
 */
export interface EventSenderCapability {
  /**
   * Accepts an addressed event for independent processing.
   * Принимает адресованное событие для независимой обработки.
   * @param address Exact listener and event address. / Точный адрес listener и события.
   * @param data Declared DTO instance. / Экземпляр объявленного DTO.
   * @returns After synchronous acceptance. / После синхронного принятия.
   * @public
   */
  readonly push: <Data>(address: ApplicationEventAddress, data: Data) => void;
}

/**
 * Best-effort WebSocket server-push capability injected as `websocket`.
 * Возможность best-effort WebSocket server push, внедряемая как `websocket`.
 * @public
 */
export interface WebSocketSenderCapability {
  /**
   * Sends one protocol message to all or selected sessions of a client.
   * Отправляет одно сообщение протокола всем или выбранным сессиям клиента.
   * @param target Delivery target. / Цель доставки.
   * @param message Outbound message. / Исходящее сообщение.
   * @returns Local delivery counters. / Локальные счётчики доставки.
   * @public
   */
  readonly send: <Body extends object>(
    target: WebSocketSendTarget,
    message: WebSocketSendMessage<Body>,
  ) => WebSocketSendResult;
}
