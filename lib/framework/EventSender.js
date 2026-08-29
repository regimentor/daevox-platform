/**
 * Narrow facade for synchronously accepting addressed application events.
 * Узкий фасад синхронного приёма адресуемых внутренних событий приложения.
 *
 * @private
 */
export class EventSender {
  /**
   * @type {Function} Bound push operation. / Связанная операция отправки.
   * @private
   */
  #push;

  /**
   * Creates a sender around the application-owned dispatcher.
   * Создаёт sender над принадлежащим приложению dispatcher.
   *
   * @param {Function} push Synchronous acceptance operation. / Синхронная операция приёма.
   * @private
   */
  constructor(push) {
    this.#push = push;
    Object.freeze(this);
  }

  /**
   * Accepts an addressed event for independent processing.
   * Принимает адресованное событие для независимой обработки.
   *
   * @param {ApplicationEventAddress} address Exact event address. / Точный адрес события.
   * @param {*} data Declared DTO instance. / Экземпляр объявленного DTO.
   * @returns {undefined} Always after acceptance. / Всегда после принятия.
   * @public
   */
  push(address, data) {
    this.#push(address, data);
    return undefined;
  }
}

/**
 * Exact address of one application-event handler.
 * Точный адрес одного обработчика внутреннего события.
 *
 * @typedef {Object} ApplicationEventAddress
 * @property {string} listener Listener wire name. / Wire-имя слушателя.
 * @property {string} event Event wire name. / Wire-имя события.
 * @public
 */
