import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { VoiceoverWorkspace } from '../voiceover/Workspace';
import { base, json, request, VoiceoverError } from '../voiceover/client';
import type { LibraryItem, Voiceover } from '../voiceover/types';

export const meta = () => [{ title: 'Перевод видео · Daevox' }];
type Activity = { kind: string; id: string; status: string } | null;
type Library = { items: LibraryItem[]; next_cursor: string | null };
function asError(error: unknown) {
  return error instanceof VoiceoverError
    ? error
    : new VoiceoverError(
        error instanceof Error ? error.message : 'Не удалось выполнить действие',
        'unknown',
      );
}

export default function VoiceoverPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity>(null);
  const [record, setRecord] = useState<Voiceover | null>(null);
  const [libraryError, setLibraryError] = useState<VoiceoverError | null>(null);
  const [recordError, setRecordError] = useState<VoiceoverError | null>(null);
  const [actionError, setActionError] = useState<VoiceoverError | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const selectedId = id ?? items[0]?.id;
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const creationKey = useRef<string | null>(null);
  const synthesisKeys = useRef(new Map<string, string>());
  const busy = useRef(false);
  const loadedMore = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [library, active] = await Promise.all([
          request<Library>('/voiceovers', { signal: controller.signal }),
          request<Activity>('/activity', { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setItems((previous) => [
          ...library.items.map((item) => {
            const previousItem = previous.find((p) => p.id === item.id);
            return previousItem && (previousItem.revision ?? 0) > (item.revision ?? 0)
              ? previousItem
              : item;
          }),
          ...previous.filter(
            (item) =>
              library.items.length > 0 &&
              (item.created_at < library.items[library.items.length - 1].created_at ||
                (item.created_at === library.items[library.items.length - 1].created_at &&
                  item.id < library.items[library.items.length - 1].id)) &&
              !library.items.some((fresh) => fresh.id === item.id),
          ),
        ]);
        if (!loadedMore.current) setNextCursor(library.next_cursor);
        setActivity(active);
        setLibraryError(null);
      } catch (error) {
        if (!controller.signal.aborted) setLibraryError(asError(error));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void refresh(), 2000);
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refreshKey]);
  useEffect(() => {
    setRecord(null);
    setRecordError(null);
    setConnectionLost(false);
    setActionError(null);
    if (!selectedId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let events: EventSource;
    function accept(value: Voiceover) {
      if (controller.signal.aborted) return;
      if (['completed', 'incomplete', 'failed', 'delete_failed'].includes(value.status)) {
        events?.close();
        setConnectionLost(false);
      }
      setRecord((previous) =>
        !previous || value.revision >= previous.revision ? value : previous,
      );
      setItems((previous) =>
        previous.map((item) =>
          item.id === value.id && (item.revision ?? 0) <= value.revision
            ? {
                ...item,
                revision: value.revision,
                source: value.source,
                title: value.source.name ?? item.title,
                status: value.status,
                stages: value.stages,
                duration: value.duration ?? item.duration,
              }
            : item,
        ),
      );
      setRecordError(null);
    }
    async function refresh() {
      try {
        accept(
          await request<Voiceover>(`/voiceovers/${selectedId}`, { signal: controller.signal }),
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          const failure = asError(error);
          setRecordError(failure);
          if ([404, 410].includes(failure.status ?? 0)) setRecord(null);
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2000);
      }
    }
    void refresh();
    events = new EventSource(`${base}/voiceovers/${selectedId}/events`);
    events.addEventListener('open', () => {
      if (!controller.signal.aborted) setConnectionLost(false);
    });
    events.addEventListener('error', () => {
      if (!controller.signal.aborted) setConnectionLost(true);
    });
    for (const kind of ['snapshot', 'progress', 'transcript', 'translation', 'state'])
      events.addEventListener(kind, (event) => {
        if (controller.signal.aborted) return;
        try {
          accept(JSON.parse((event as MessageEvent<string>).data));
          setConnectionLost(false);
        } catch {
          setConnectionLost(true);
        }
      });
    events.addEventListener('deleted', () => {
      if (!controller.signal.aborted) {
        setRecord(null);
        setItems((previous) => previous.filter((item) => item.id !== selectedId));
        navigate('/voiceover', { replace: true });
      }
    });
    return () => {
      controller.abort();
      events.close();
      clearTimeout(timer);
    };
  }, [selectedId, refreshKey, navigate]);
  async function act(action: () => Promise<void>) {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(asError(error));
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function acceptMutation(value: Voiceover) {
    if (selected.current === value.id)
      setRecord((previous) =>
        !previous || value.revision >= previous.revision ? value : previous,
      );
  }
  return (
    <VoiceoverWorkspace
      items={items}
      record={record?.id === selectedId ? record : null}
      selectedId={selectedId}
      activity={activity}
      loading={loading}
      pending={pending}
      connectionLost={connectionLost}
      error={actionError ?? recordError ?? libraryError}
      nextCursor={nextCursor}
      onRefresh={() => setRefreshKey((value) => value + 1)}
      onSourceChange={() => {
        creationKey.current = null;
      }}
      onCreate={(file, url, options) =>
        act(async () => {
          creationKey.current ??= crypto.randomUUID();
          const value = await request<Voiceover>(
            '/voiceovers',
            json({
              ...(file
                ? { source_kind: 'file', filename: file.name }
                : { source_kind: 'youtube', url }),
              ...options,
              client_request_id: creationKey.current,
            }),
          );
          if (file && value.status === 'awaiting_upload')
            await request(`/voiceovers/${value.id}/source`, { method: 'PUT', body: file });
          creationKey.current = null;
          navigate(`/voiceover/${value.id}`);
          setRefreshKey((key) => key + 1);
        })
      }
      onAssign={(assignments) =>
        act(async () => {
          if (!record) return;
          acceptMutation(
            await request<Voiceover>(
              `/voiceovers/${record.id}/voices`,
              json({ expected_revision: record.revision, voice_assignments: assignments }, 'PUT'),
            ),
          );
        })
      }
      onSynthesize={() =>
        act(async () => {
          if (!record) return;
          if (['completed', 'incomplete'].includes(record.status))
            synthesisKeys.current.delete(record.id);
          const key = synthesisKeys.current.get(record.id) ?? crypto.randomUUID();
          synthesisKeys.current.set(record.id, key);
          acceptMutation(
            await request<Voiceover>(
              `/voiceovers/${record.id}/synthesize`,
              json({ expected_revision: record.revision, client_request_id: key }),
            ),
          );
        })
      }
      onRetryPhrase={(phraseId, adaptedText) =>
        act(async () => {
          if (!record) return;
          acceptMutation(
            await request<Voiceover>(
              `/voiceovers/${record.id}/phrases/${encodeURIComponent(phraseId)}/retry`,
              json({
                expected_revision: record.revision,
                client_request_id: crypto.randomUUID(),
                adapted_text: adaptedText,
              }),
            ),
          );
        })
      }
      onReplaceSample={(speakerId, sample) =>
        act(async () => {
          if (!record) return;
          acceptMutation(
            await request<Voiceover>(
              `/voiceovers/${record.id}/speakers/${encodeURIComponent(speakerId)}/sample?expected_revision=${record.revision}`,
              { method: 'PUT', body: sample },
            ),
          );
        })
      }
      onDelete={() =>
        act(async () => {
          if (!record) return;
          await request(`/voiceovers/${record.id}`, { method: 'DELETE' });
          setItems((previous) => previous.filter((item) => item.id !== record.id));
          setRecord(null);
          navigate('/voiceover');
          setRefreshKey((key) => key + 1);
        })
      }
      onLoadMore={() =>
        act(async () => {
          if (!nextCursor) return;
          const page = await request<Library>(
            `/voiceovers?cursor=${encodeURIComponent(nextCursor)}`,
          );
          setItems((previous) => [
            ...previous,
            ...page.items.filter((item) => !previous.some((p) => p.id === item.id)),
          ]);
          loadedMore.current = true;
          setNextCursor(page.next_cursor);
        })
      }
    />
  );
}
