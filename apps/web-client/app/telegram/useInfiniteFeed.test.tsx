import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useInfiniteFeed } from './useInfiniteFeed';

type Page = { context: { accountId: string }; nextCursor: string | null; items: string[] };
function Feed({ account = '1' }: { account?: string }) {
  const { pages, sentinel, hasMore, error } = useInfiniteFeed<Page>(
    `/feed?accountId=${account}`,
    account,
  );
  return (
    <>
      <div>{pages.flatMap((page) => page.items).join(',')}</div>
      {hasMore && <div ref={sentinel} />}
      {error && <span>error</span>}
    </>
  );
}
afterEach(() => vi.unstubAllGlobals());

it('appends ten-item pages, prevents concurrent loads and stops at the end', async () => {
  let intersect!: () => void;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersect = () => callback([{ isIntersecting: true }]);
      }
      observe() {}
      disconnect() {}
    },
  );
  let resolve!: (value: Response) => void;
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ context: { accountId: '1' }, items: ['new'], nextCursor: '11' }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
  vi.stubGlobal('fetch', fetchMock);
  render(<Feed />);
  await screen.findByText('new');
  await act(async () => {
    intersect();
    intersect();
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][0]).toBe('/feed?accountId=1&limit=10');
  expect(fetchMock.mock.calls[1][0]).toBe('/feed?accountId=1&limit=10&before=11');
  await act(async () =>
    resolve(Response.json({ context: { accountId: '1' }, items: ['old'], nextCursor: null })),
  );
  expect(screen.getByText('new,old')).toBeInTheDocument();
  await act(async () => intersect());
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('aborts the old account request and ignores its late response', async () => {
  let resolve!: (value: Response) => void;
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(
      Response.json({ context: { accountId: '2' }, items: ['second'], nextCursor: null }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const { rerender } = render(<Feed />);
  rerender(<Feed account="2" />);
  await screen.findByText('second');
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () =>
    resolve(Response.json({ context: { accountId: '1' }, items: ['first'], nextCursor: null })),
  );
  await waitFor(() => expect(screen.queryByText('first')).not.toBeInTheDocument());
});
