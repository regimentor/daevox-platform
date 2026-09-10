export type Segment = {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker_id: string | null;
  speaker_status: 'pending' | 'assigned' | 'unknown';
  overlap: boolean;
};
export type Stage = {
  state: 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';
  completed_units: number;
  total_units: number | null;
  unit: string;
  detail: string | null;
};
export type Snapshot = {
  operation_id: string;
  revision: number;
  status: 'awaiting_upload' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  source: { kind: string; name?: string; url?: string };
  language_requested: string;
  language_detected: string | null;
  stages: Record<string, Stage>;
  transcript_revision: number;
  segments: Segment[];
  speakers: { id: string; label: string }[];
  speaker_turns: { start: number; end: number; speaker_id: string }[];
  completeness: { asr: boolean; diarization: boolean };
  output_paths: Record<string, string>;
  error: { code: string; message: string; stage: string | null } | null;
};
export const base = '/trancription-api/operations';
export const isTerminal = (snapshot: Snapshot) =>
  ['completed', 'cancelled', 'failed'].includes(snapshot.status);

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    if (response.status === 409)
      throw new Error('Уже выполняется операция или источник уже принят. Обновите состояние.');
    throw new Error(
      `Сервис не принял запрос (${response.status}). Проверьте источник и подключение.`,
    );
  }
  return response.json();
}

type TranscriptEvent = {
  revision: number;
  transcript_revision: number;
  start_index: number;
  delete_count: number;
  segments: Segment[];
  speakers: Snapshot['speakers'];
  speaker_turns: Snapshot['speaker_turns'];
};

export function subscribe(
  snapshot: Snapshot,
  update: (next: Snapshot) => void,
  connection: (online: boolean) => void,
) {
  let current = snapshot;
  const source = new EventSource(`${base}/${snapshot.operation_id}/events`);
  source.addEventListener('open', () => connection(true));
  source.addEventListener('error', () => connection(false));
  const replace = (event: MessageEvent<string>) => {
    const next: Snapshot = JSON.parse(event.data);
    if (next.revision >= current.revision) {
      current = next;
      update(next);
    }
    if (isTerminal(next)) source.close();
  };
  source.addEventListener('snapshot', replace);
  source.addEventListener('terminal', replace);
  source.addEventListener('stage', (event: MessageEvent<string>) => {
    const data: { revision: number; changes: Partial<Snapshot> } = JSON.parse(event.data);
    if (data.revision <= current.revision) return;
    current = { ...current, ...data.changes, revision: data.revision };
    update(current);
  });
  source.addEventListener('transcript', (event: MessageEvent<string>) => {
    const data: TranscriptEvent = JSON.parse(event.data);
    if (data.revision <= current.revision) return;
    const segments = [...current.segments];
    segments.splice(data.start_index, data.delete_count, ...data.segments);
    current = {
      ...current,
      segments,
      revision: data.revision,
      transcript_revision: data.transcript_revision,
      speakers: data.speakers,
      speaker_turns: data.speaker_turns,
    };
    update(current);
  });
  return () => source.close();
}
