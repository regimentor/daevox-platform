import { Application, ScheduledTaskBase } from '../../src/index.ts';
import type {
  ScheduledTaskClass,
  ScheduledTaskContext,
  ScheduledTaskOptions,
  ScheduledTasksOptions,
} from '../../src/index.ts';

class State {
  value = 1;
}
class OtherState {
  other = '';
}
class Valid extends ScheduledTaskBase {
  static cron = '* * * * * *';
  // oxlint-disable-next-line no-useless-constructor -- Verify the public constructor DI type.
  constructor(options: ScheduledTaskOptions) {
    super(options);
  }
  async run(state: State, context: ScheduledTaskContext): Promise<void> {
    void state.value;
    void context.signal;
  }
}
class OneArgument extends ScheduledTaskBase {
  static cron = '* * * * * *';
  run(state: State): Promise<void> {
    void state.value;
    return Promise.resolve();
  }
}
class WrongState extends ScheduledTaskBase {
  static cron = '* * * * * *';
  async run(state: OtherState) {
    void state.other;
  }
}
class WrongResult extends ScheduledTaskBase {
  static cron = '* * * * * *';
  run() {
    return 1;
  }
}
class MissingCron extends ScheduledTaskBase {
  async run() {}
}
class MissingRun extends ScheduledTaskBase {
  static cron = '* * * * * *';
}

function registrationTypes(app: Application<State>) {
  app.registerScheduledTask(Valid).registerScheduledTask(OneArgument);
  app.registerRuntimeScheduledTask(Valid).registerRuntimeScheduledTask(OneArgument);
  const task: ScheduledTaskClass<State> = Valid;
  void task;
  // @ts-expect-error AppState is fixed by Application, not inferred from registration.
  app.registerScheduledTask(WrongState);
  // @ts-expect-error Runtime registration enforces the same AppState contract.
  app.registerRuntimeScheduledTask(WrongState);
  // @ts-expect-error ScheduledTask.run must return Promise<void>.
  app.registerScheduledTask(WrongResult);
  // @ts-expect-error cron metadata is required.
  app.registerScheduledTask(MissingCron);
  // @ts-expect-error run is required.
  app.registerRuntimeScheduledTask(MissingRun);
}
void registrationTypes;
const options: ScheduledTasksOptions = {
  onError(error, context) {
    const phase: 'constructor' | 'run' | 'shutdown' = context.phase;
    const name: string = context.taskName;
    void [error, phase, name, context.taskClass];
  },
};
void options;
