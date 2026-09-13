import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CoreClient,
  type RuntimeSnapshot,
  type PresetCatalog,
  type MetricSample,
  type Operation,
  type EventEnvelope,
  type ModelSet,
} from '@daevox/core/client';
export const api = new CoreClient();
export const phases: Record<RuntimeSnapshot['state'], string> = {
  empty: 'Не загружена',
  ready: 'Готова',
  waiting: 'Ожидание запросов',
  unloading: 'Выгрузка',
  loading: 'Загрузка',
  error: 'Ошибка',
  recovery_required: 'Требуется восстановление',
};
type State = {
  modelSets: ModelSet[];
  operations: Operation[];
  runtime: RuntimeSnapshot | null;
  catalog: PresetCatalog | null;
  metric: MetricSample | null;
  connected: boolean;
  gap: boolean;
  refresh: () => Promise<void>;
};
const Context = createContext<State>({
  modelSets: [],
  operations: [],
  runtime: null,
  catalog: null,
  metric: null,
  connected: false,
  gap: false,
  refresh: async () => {},
});
export function CoreProvider({ children }: { children: ReactNode }) {
  const [modelSets, setModelSets] = useState<ModelSet[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [catalog, setCatalog] = useState<PresetCatalog | null>(null);
  const [metric, setMetric] = useState<MetricSample | null>(null);
  const [connected, setConnected] = useState(false);
  const [gap, setGap] = useState(false);
  const alive = useRef(false);
  const refreshVersion = useRef(0);
  const eventsOpen = useRef(false);
  const readRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = async () => {
    const version = ++refreshVersion.current;
    try {
      const [nextRuntime, nextCatalog, nextOperations, sets] = await Promise.all([
        api.runtime(),
        api.presets(),
        api.operations(),
        api.modelSets(),
      ]);
      if (alive.current && version === refreshVersion.current) {
        setRuntime(nextRuntime);
        setCatalog(nextCatalog);
        setOperations(nextOperations.operations);
        setModelSets(sets.model_sets);
        clearTimeout(readRetry.current);
        setConnected(eventsOpen.current);
      }
    } catch {
      if (alive.current && version === refreshVersion.current) {
        setConnected(false);
        clearTimeout(readRetry.current);
        readRetry.current = setTimeout(() => {
          if (alive.current && version === refreshVersion.current) void refresh();
        }, 1000);
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    let session = '';
    let seq = -1;
    const retiredSessions = new Set<string>();
    const events = new EventSource('/core/events');
    events.addEventListener('open', () => {
      eventsOpen.current = true;
      setConnected(true);
    });
    events.addEventListener('error', () => {
      eventsOpen.current = false;
      setConnected(false);
    });
    const receive = (event: MessageEvent<string>) => {
      const envelope = JSON.parse(event.data) as EventEnvelope;
      if (retiredSessions.has(envelope.session_id)) return;
      if (session !== envelope.session_id) {
        if (envelope.type !== 'snapshot') {
          if (envelope.type === 'gap') setGap(true);
          return;
        }
        if (session) retiredSessions.add(session);
        ++refreshVersion.current;
        session = envelope.session_id;
        seq = -1;
        setMetric(null);
      }
      if (envelope.seq <= seq) return;
      seq = envelope.seq;
      if (envelope.type === 'gap') setGap(true);
      else if (envelope.type === 'metric.sample') setMetric(envelope.payload);
      else void refresh();
    };
    for (const type of [
      'snapshot',
      'runtime.changed',
      'operation.changed',
      'catalog.changed',
      'preset.changed',
      'build.changed',
      'metric.sample',
      'gap',
    ])
      events.addEventListener(type, receive);
    return () => {
      alive.current = false;
      eventsOpen.current = false;
      clearTimeout(readRetry.current);
      ++refreshVersion.current;
      events.close();
    };
  }, []);
  return (
    <Context.Provider
      value={{ modelSets, operations, runtime, catalog, metric, connected, gap, refresh }}
    >
      {children}
    </Context.Provider>
  );
}
export const useCore = () => useContext(Context);
