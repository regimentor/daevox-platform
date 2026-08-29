/**
 * Narrow facade for synchronously accepting addressed application events.
 * Узкий фасад синхронного приёма адресуемых внутренних событий приложения.
 * @private
 */
export class EventSender {
  /**
   * Bound push operation. / Связанная операция отправки.
   * @private
   */
  #push: ApplicationEventPush;

  /**
   * Creates a sender around the application-owned dispatcher.
   * Создаёт sender над принадлежащим приложению dispatcher.
   * @param push Synchronous acceptance operation. / Синхронная операция приёма.
   * @private
   */
  constructor(push: ApplicationEventPush) {
    this.#push = push;
    Object.freeze(this);
  }

  /**
   * Accepts an addressed event for independent processing.
   * Принимает адресованное событие для независимой обработки.
   * @param address Exact event address. / Точный адрес события.
   * @param data Declared DTO instance. / Экземпляр объявленного DTO.
   * @returns Always after acceptance. / Всегда после принятия.
   * @public
   */
  push<Data>(address: ApplicationEventAddress, data: Data): void {
    this.#push(address, data);
  }
}

/** Exact address of one application-event handler. / Точный адрес обработчика события. @public */
export interface ApplicationEventAddress {
  listener: string;
  event: string;
}

/** Synchronous application-event acceptance operation. / Операция приёма события. @private */
export type ApplicationEventPush = (address: ApplicationEventAddress, data: unknown) => void;
