import { useEffect, useRef, useState } from 'react';

type Page = { context: { accountId: string | null }; nextCursor: string | null };

/** Serializes pagination and polling; each request reads at most ten items. */
export function useInfiniteFeed<T extends Page>(url: string, accountId: string) {
  const [pages, setPages] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef<() => void>(() => {});
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let busy = false;
    let current: T[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setPages([]);
    setLoading(true);
    setError(false);
    const read = async (before: string | null) => {
      const params = new URLSearchParams({ limit: '10' });
      if (before) params.set('before', before);
      const response = await fetch(`${url}&${params}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('feed');
      const page = (await response.json()) as T;
      if (page.context.accountId !== accountId) throw new Error('account');
      return page;
    };
    const load = async (append = false) => {
      if (busy || cancelled) return;
      const cursor = current.at(-1)?.nextCursor;
      if (append && !cursor) return;
      busy = true;
      clearTimeout(timer);
      if (append || current.length === 0) setLoading(true);
      setError(false);
      try {
        let next: T[];
        if (append) next = [...current, await read(cursor!)];
        else {
          next = [await read(null)];
          // Refresh the loaded prefix so new entries cannot leave gaps between pages.
          while (next.length < current.length && next.at(-1)?.nextCursor) {
            next.push(await read(next.at(-1)!.nextCursor));
          }
        }
        if (!cancelled) {
          current = next;
          setPages(next);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        busy = false;
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(() => void load(), 2000);
        }
      }
    };
    loadMore.current = () => void load(true);
    refresh.current = () => void load();
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, accountId]);

  const hasMore = !!pages.at(-1)?.nextCursor;
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore || loading || error || typeof IntersectionObserver === 'undefined')
      return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore.current();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loading, error, pages]);

  return { pages, loading, error, hasMore, sentinel, refresh: () => refresh.current() };
}
