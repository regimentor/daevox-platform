// oxlint-disable-next-line typescript/no-extraneous-class -- DTO class provides nominal identity.
export class OrderCreated {
  declare orderId: any;

  constructor(orderId: any) {
    this.orderId = orderId;
  }
}
