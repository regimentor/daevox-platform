// oxlint-disable-next-line typescript/no-extraneous-class -- DTO class provides nominal identity.
export class OrderCreated {
  constructor(orderId) {
    this.orderId = orderId;
  }
}
