import { HttpControllerBase } from '../../lib/framework/HttpControllerBase.ts';

/**
 * Publishes a notification to the example WebSocket client.
 * Публикует уведомление демонстрационному WebSocket-клиенту.
 *
 * @public
 */
export class BroadcastController extends HttpControllerBase {
  static prefix = '/broadcast';
  static routes = [{ method: 'GET', path: '/', handler: 'publish' }];

  /**
   * Sends a notification through the application-wide WebSocket sender.
   * Отправляет уведомление через общий WebSocket sender приложения.
   *
   * @returns HTTP result. / HTTP-результат.
   * @public
   */
  publish() {
    return {
      status: 200,
      body: this.websocket.send(
        { clientId: 'example-client' },
        {
          controller: 'notifications',
          event: 'updated',
          body: { message: 'Server push from HTTP' },
        },
      ),
    };
  }
}
