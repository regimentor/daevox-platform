import {
  Application,
  HttpControllerBase,
  minLength,
  required,
  type HttpRequestContext,
  type HttpRouteJsonBodySchema,
} from '@daevox/framework';
import { ExampleAppState } from '../ExampleAppState.ts';

class AddressBody {
  street!: string;

  static schema = {
    street: { type: String, validators: [required(), minLength(1)] },
  } as const satisfies HttpRouteJsonBodySchema<AddressBody>;
}

class CreateUserBody {
  name!: string;
  address!: AddressBody;
  aliases!: string[];

  static schema = {
    name: { type: String, validators: [required(), minLength(2)] },
    address: { type: AddressBody, validators: [required()] },
    aliases: { type: [String] },
  } as const satisfies HttpRouteJsonBodySchema<CreateUserBody>;
}

class UsersController extends HttpControllerBase {
  static prefix = '/users';
  static routes = [{ method: 'POST', path: '/', handler: 'create', body: CreateUserBody }] as const;

  async create(_appState: ExampleAppState, context: HttpRequestContext<CreateUserBody>) {
    const body = await context.requestBody.json();
    return {
      status: 201,
      body: {
        className: body.constructor.name,
        name: body.name,
        street: body.address.street,
        aliases: body.aliases,
      },
    };
  }
}

export function createHttpJsonBodyContractApplication() {
  return new Application({ appState: ExampleAppState }).registerHttpController(UsersController);
}
