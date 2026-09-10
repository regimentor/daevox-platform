import { Application, ScheduledTaskBase } from '../../src/index.ts';

class State {
  value = 1;
}
class Tick extends ScheduledTaskBase {
  static cron = '0 0 0 1 1 *';
  async run() {}
}
for (let iteration = 0; iteration < 20; iteration++) {
  const app = new Application({ appState: State }).registerScheduledTask(Tick);
  await app.listen({ port: 0 });
  app.registerRuntimeScheduledTask(
    class Runtime extends ScheduledTaskBase {
      static cron = '* * * * * *';
      async run() {}
    },
  );
  await app.close();
}
console.log('closed 20 Applications');
