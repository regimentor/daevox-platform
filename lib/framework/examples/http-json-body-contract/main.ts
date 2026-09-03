import { createHttpJsonBodyContractApplication } from './application.ts';

const application = createHttpJsonBodyContractApplication();
const address = await application.listen({ port: 3000 });
console.log(
  `HTTP JSON body contract example listening on http://${address.address}:${address.port}`,
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await application.close();
    process.exitCode = 0;
  });
}
