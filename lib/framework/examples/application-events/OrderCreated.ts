// oxlint-disable-next-line typescript/no-extraneous-class -- DTO class provides nominal identity.
export class OrderCreated {
  declare orderId: string;

  constructor(orderId: string) {
    this.orderId = orderId;
  }
}
