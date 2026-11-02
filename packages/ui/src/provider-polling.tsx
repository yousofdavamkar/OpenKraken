import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Request, Result } from '@openkraken/ipc-contract';

type ReadMethod =
  | 'providerPollingPolicy'
  | 'providerIssues'
  | 'providerIssue'
  | 'providerIssueComments'
  | 'providerPullRequests'
  | 'providerPullRequest'
  | 'providerMergeRequest'
  | 'providerMergeRequestFiles'
  | 'providerMergeRequestDiscussions'
  | 'providerPullFiles'
  | 'providerPullReviews'
  | 'providerPullComments'
  | 'providerPullChecks';
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type PollRequest = WithoutId<Extract<Request, { method: ReadMethod }>>;
export type PollRead = (request: PollRequest) => Promise<Result>;
type Update = { commit: () => void; resetChildren?: boolean };
type Job = { priority: number; busy: boolean; load: (read: PollRead) => Promise<Update> };
class Cancelled extends Error {}
class PollError extends Error {
  constructor(
    message: string,
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

class RefreshSession {
  jobs = new Set<Job>();
  revision = 0;
  requests = new Set<string>();
  invalidate = () => {
    this.revision++;
    for (const id of this.requests) void window.openkraken.cancel(id);
    this.requests.clear();
  };
  register(job: Job) {
    this.invalidate();
    this.jobs.add(job);
    return () => {
      this.jobs.delete(job);
      this.invalidate();
    };
  }
}
const Context = createContext<RefreshSession | null>(null);

/** Register an atomic update, without clearing visible data during its reads. */
export function useProviderPoll(busy: boolean, version: string, load: Job['load'], priority = 2) {
  const session = useContext(Context);
  const latest = useRef(load);
  useLayoutEffect(() => {
    latest.current = load;
  });
  useLayoutEffect(
    () => session?.register({ busy, priority, load: (read) => latest.current(read) }),
    [session, busy, priority, version],
  );
}

export async function pollNumberedPages<T>(
  count: number,
  load: (page: number) => Promise<{ items: T[]; nextPage: number | null; limited: boolean }>,
  identity: (item: T) => string | number,
) {
  const items = new Map<string | number, T>();
  let nextPage: number | null = 1;
  let limited = false;
  for (let i = 0; i < Math.min(100, count) && nextPage !== null; i++) {
    const number: number = nextPage;
    const page = await load(number);
    for (const item of page.items) items.set(identity(item), item);
    if (page.nextPage !== null && page.nextPage <= number)
      throw new Error('The provider repeated a page. Refresh manually to continue.');
    nextPage = page.nextPage;
    limited = page.limited;
  }
  return { items: [...items.values()], nextPage, limited };
}

const choices = [0, 1, 5, 15];
export function ProviderPolling({
  accountId,
  scope,
  children,
}: {
  accountId: string;
  scope: string;
  children: ReactNode;
}) {
  const storageKey = `openkraken.providerPolling.${accountId}.${scope}`;
  const [minutes, setMinutes] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return choices.includes(saved) ? saved : 0;
    } catch {
      return 0;
    }
  });
  const [notice, setNotice] = useState('');
  const [paused, setPaused] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const session = useMemo(() => new RefreshSession(), [accountId, scope]);
  useEffect(() => {
    if (!minutes) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    let lastFinished = Date.now();
    let minimumInterval = 0;
    let retryAt = 0;
    const pauseReason = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus())
        return 'Paused while this window is inactive.';
      const dialog = root.current?.closest('dialog');
      if (
        !dialog?.open ||
        [...document.querySelectorAll('dialog[open]')].some((item) => item !== dialog)
      )
        return 'Paused while another dialog is open.';
      return '';
    };
    const eligibilityChanged = () => {
      const reason = pauseReason();
      setPaused(reason);
      if (reason) session.invalidate();
    };
    const observer = new MutationObserver(eligibilityChanged);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    document.addEventListener('visibilitychange', eligibilityChanged);
    window.addEventListener('blur', eligibilityChanged);
    window.addEventListener('focus', eligibilityChanged);
    // User input cancels a snapshot before it can move a selection or replace a draft.
    document.addEventListener('pointerdown', session.invalidate, true);
    document.addEventListener('keydown', session.invalidate, true);
    document.addEventListener('wheel', session.invalidate, true);
    document.addEventListener('input', session.invalidate, true);
    document.addEventListener('change', session.invalidate, true);
    const delay = () => Math.max(Math.min(60, minutes * 2 ** failures) * 60000, minimumInterval);
    const schedule = (deadline = Math.max(lastFinished + delay(), retryAt)) => {
      if (!stopped)
        timer = setTimeout(
          () => void tick(),
          Math.max(1, Math.min(86400000, deadline - Date.now())),
        );
    };
    const tick = async () => {
      if (stopped) return;
      eligibilityChanged();
      if (pauseReason() || !session.jobs.size || [...session.jobs].some((job) => job.busy)) {
        lastFinished = Date.now();
        schedule();
        return;
      }
      const revision = session.revision;
      const guard = () => {
        if (stopped || revision !== session.revision || pauseReason()) throw new Cancelled();
      };
      const read: PollRead = async (request) => {
        guard();
        const id = crypto.randomUUID();
        session.requests.add(id);
        try {
          const result = await window.openkraken.request({ ...request, id });
          guard();
          if (result.kind === 'cancelled') throw new Cancelled();
          if (result.kind === 'error') throw new PollError(result.message, result.retryAt);
          return result;
        } finally {
          session.requests.delete(id);
        }
      };
      try {
        const policy = await read({ method: 'providerPollingPolicy', accountId });
        if (policy.kind !== 'providerPollingPolicy')
          throw new Error('Provider timing could not be read.');
        minimumInterval = policy.policy.minimumIntervalMs;
        retryAt = policy.policy.blockedUntil ?? 0;
        const deadline = Math.max(lastFinished + delay(), retryAt);
        if (Date.now() < deadline) {
          setNotice('Waiting for the next refresh allowed by the provider.');
          schedule(deadline);
          return;
        }
        setNotice('Refreshing automatically…');
        const updates: Update[] = [];
        for (const job of [...session.jobs].sort((a, b) => a.priority - b.priority)) {
          guard();
          const update = await job.load(read);
          updates.push(update);
          if (update.resetChildren) break;
        }
        guard();
        for (const update of updates) update.commit();
        failures = 0;
        retryAt = 0;
        setNotice('Automatic refresh completed.');
      } catch (error) {
        if (stopped) return;
        if (error instanceof Cancelled)
          setNotice('Automatic refresh cancelled; existing results kept.');
        else {
          failures = Math.min(6, failures + 1);
          retryAt = error instanceof PollError ? (error.retryAt ?? 0) : 0;
          setNotice(
            `Automatic refresh failed: ${error instanceof Error ? error.message : 'Request failed'}. Existing results kept; another attempt is scheduled.`,
          );
        }
      }
      lastFinished = Date.now();
      schedule();
    };
    eligibilityChanged();
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      session.invalidate();
      observer.disconnect();
      document.removeEventListener('visibilitychange', eligibilityChanged);
      window.removeEventListener('blur', eligibilityChanged);
      window.removeEventListener('focus', eligibilityChanged);
      document.removeEventListener('pointerdown', session.invalidate, true);
      document.removeEventListener('keydown', session.invalidate, true);
      document.removeEventListener('wheel', session.invalidate, true);
      document.removeEventListener('input', session.invalidate, true);
      document.removeEventListener('change', session.invalidate, true);
    };
  }, [accountId, minutes, session]);
  return (
    <Context.Provider value={session}>
      <div ref={root}>
        <label>
          Automatic refresh{' '}
          <select
            aria-label="Automatic refresh"
            value={minutes}
            onChange={(event) => {
              const value = Number(event.target.value);
              setMinutes(choices.includes(value) ? value : 0);
              setNotice('');
              setPaused('');
              try {
                localStorage.setItem(storageKey, String(value));
              } catch {
                /* The session setting still applies. */
              }
            }}
          >
            {choices.map((value) => (
              <option key={value} value={value}>
                {value ? `Every ${value} minute${value === 1 ? '' : 's'}` : 'Off'}
              </option>
            ))}
          </select>
        </label>
        {minutes > 0 && (
          <p role="status" aria-label="Automatic refresh status">
            {paused || notice || 'Automatic refresh scheduled.'}
          </p>
        )}
        {children}
      </div>
    </Context.Provider>
  );
}
