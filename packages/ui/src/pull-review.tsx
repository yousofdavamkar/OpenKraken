import { useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import type {
  ProviderPullDetails,
  ProviderPullFile,
  ProviderPullOptions,
  ProviderPullReview,
  ProviderSubmitReview,
} from '@openkraken/ipc-contract';
export type PullContext = {
  accountId: string;
  repository: ProviderPullOptions['repository'];
  detail: ProviderPullDetails;
};

function Patch({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const document = EditorState.create({ doc: text });
    const decorations = [];
    for (let i = 1; i <= document.doc.lines; i++) {
      const line = document.doc.line(i);
      const kind = line.text.startsWith('@@')
        ? 'hunk'
        : line.text.startsWith('+')
          ? 'added'
          : line.text.startsWith('-')
            ? 'removed'
            : undefined;
      if (kind) decorations.push(Decoration.line({ class: `pr-patch-${kind}` }).range(line.from));
    }
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': 'Provider patch', tabindex: '0' }),
          lineNumbers(),
          keymap.of(defaultKeymap),
          EditorView.decorations.of(Decoration.set(decorations)),
          EditorView.theme(
            {
              '&': { height: '300px', backgroundColor: '#10151e', color: '#d8e5f5' },
              '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace' },
              '.cm-gutters': { backgroundColor: '#182332', color: '#9daec2' },
            },
            { dark: true },
          ),
        ],
      }),
    });
    return () => view.destroy();
  }, [text]);
  return <div ref={host} className="pr-patch" />;
}
export function PullFiles({ context }: { context: PullContext }) {
  const { accountId, repository, detail } = context;
  const [files, setFiles] = useState<ProviderPullFile[]>([]);
  const [page, setPage] = useState(1),
    [attempt, setAttempt] = useState(0);
  const [next, setNext] = useState<number | null>(null),
    [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true),
    [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [active, setActive] = useState(0);
  const listId = useId();
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'providerPullFiles',
        accountId,
        options: {
          repository,
          number: detail.number,
          revision: { head: detail.head.sha, base: detail.base.sha },
          page,
        },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') {
          setError(result.message);
          if (result.code === 'STALE_PROVIDER_PULL') {
            setFiles([]);
            setSelected(undefined);
          }
        }
        if (result.kind === 'providerPullFiles') {
          setFiles((current) => {
            const unique = new Map((page === 1 ? [] : current).map((file) => [file.path, file]));
            for (const file of result.page.files) unique.set(file.path, file);
            return [...unique.values()];
          });
          setNext(result.page.nextPage);
          setLimited(result.page.limited);
        }
      })
      .catch(() => {
        if (alive) setError('Changed files could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [accountId, repository, detail, page, attempt]);
  const virtual = useVirtualizer({
    count: files.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 42,
    overscan: 3,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(files[active] ? [active] : [])])].sort(
        (a, b) => a - b,
      ),
  });
  const file = files.find((entry) => entry.path === selected);
  return (
    <section aria-label="Pull-request files">
      <p role="status">
        {files.length} files loaded{pending ? ' · Loading…' : ''}
      </p>
      <div
        ref={scroll}
        className="pr-files"
        role="listbox"
        aria-label="Changed files"
        tabIndex={0}
        aria-activedescendant={files[active] ? `${listId}-${active}` : undefined}
        onKeyDown={(event) => {
          let index = active;
          if (event.key === 'ArrowDown') index++;
          else if (event.key === 'ArrowUp') index--;
          else if (event.key === 'Home') index = 0;
          else if (event.key === 'End') index = files.length - 1;
          else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (files[active]) setSelected(files[active].path);
            return;
          } else return;
          event.preventDefault();
          index = Math.max(0, Math.min(index, files.length - 1));
          setActive(index);
          virtual.scrollToIndex(index);
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const entry = files[item.index]!;
            return (
              <div
                role="option"
                id={`${listId}-${item.index}`}
                key={entry.path}
                className="pr-file"
                title={entry.path}
                aria-selected={selected === entry.path}
                aria-posinset={item.index + 1}
                aria-setsize={files.length}
                data-active={active === item.index}
                onClick={() => {
                  setActive(item.index);
                  setSelected(entry.path);
                  scroll.current?.focus();
                }}
                style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
              >
                {entry.status} · {entry.path} (+{entry.additions} / −{entry.deletions})
              </div>
            );
          })}
        </div>
      </div>
      {error && (
        <p role="alert">
          {error}{' '}
          <button disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
            Retry files
          </button>
        </p>
      )}
      {next !== null && !error && (
        <button disabled={pending} onClick={() => setPage(next)}>
          Load more files
        </button>
      )}
      {limited && (
        <p>The provider limits this list to 3,000 files. Further files may be omitted.</p>
      )}
      {file && (
        <section aria-label="Selected file patch">
          <h4>{file.path}</h4>
          {file.previousPath && <p>Previously: {file.previousPath}</p>}
          {file.patch === null ? (
            <p>No patch was supplied by the provider.</p>
          ) : (
            <Patch text={file.patch} />
          )}
          {file.patchTruncated && <p>This patch exceeds the display limit and is truncated.</p>}
        </section>
      )}
    </section>
  );
}
export function PullReviews({
  context,
  onLoaded,
}: {
  context: PullContext;
  onLoaded?: () => void;
}) {
  const { accountId, repository, detail } = context;
  const [reviews, setReviews] = useState<ProviderPullReview[]>([]);
  const [page, setPage] = useState(1),
    [attempt, setAttempt] = useState(0);
  const [next, setNext] = useState<number | null>(null),
    [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true),
    [error, setError] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request({
        id,
        method: 'providerPullReviews',
        accountId,
        options: { repository, number: detail.number, page },
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setError(result.message);
        if (result.kind === 'providerPullReviews') {
          setReviews((current) => {
            const unique = new Map(
              (page === 1 ? [] : current).map((review) => [review.id, review]),
            );
            for (const review of result.page.reviews) unique.set(review.id, review);
            return [...unique.values()];
          });
          setNext(result.page.nextPage);
          setLimited(result.page.limited);
          loaded.current?.();
        }
      })
      .catch(() => {
        if (alive) setError('Reviews could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [accountId, repository, detail.number, page, attempt]);
  const virtual = useVirtualizer({
    count: reviews.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 180,
    overscan: 2,
  });
  return (
    <section aria-label="Pull-request reviews">
      <p role="status">
        {reviews.length} reviews loaded{pending ? ' · Loading…' : ''}
      </p>
      <div ref={scroll} className="pr-reviews" role="list" aria-label="Reviews">
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const review = reviews[item.index]!;
            return (
              <article
                key={review.id}
                role="listitem"
                data-index={item.index}
                ref={virtual.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  transform: `translateY(${item.start}px)`,
                  width: '100%',
                }}
              >
                <strong>
                  {review.author ?? 'Deleted account'} · {review.state.replaceAll('_', ' ')}
                </strong>
                <p>
                  {review.submittedAt
                    ? new Date(review.submittedAt).toLocaleString()
                    : 'Not submitted'}
                </p>
                <pre>{review.body || 'No review text.'}</pre>
                {review.commitId && (
                  <p>
                    Commit: <code>{review.commitId}</code>
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {error && (
        <p role="alert">
          {error}{' '}
          <button disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
            Retry reviews
          </button>
        </p>
      )}
      {next !== null && !error && (
        <button disabled={pending} onClick={() => setPage(next)}>
          Load more reviews
        </button>
      )}
      {limited && <p>Showing at most 10,000 reviews.</p>}
      <button
        disabled={pending}
        onClick={() => {
          setReviews([]);
          setNext(null);
          setPage(1);
          setAttempt((value) => value + 1);
        }}
      >
        Refresh reviews
      </button>
    </section>
  );
}
function ReviewDialog({
  context,
  close,
  submitted,
}: {
  context: PullContext;
  close: () => void;
  submitted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    request = useRef<string | undefined>(undefined);
  const [event, setEvent] = useState<ProviderSubmitReview['event']>('COMMENT'),
    [body, setBody] = useState('');
  const [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState(false),
    [discard, setDiscard] = useState(false);
  const [result, setResult] = useState<ProviderPullReview>();
  const [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [checking, setChecking] = useState(false),
    [checked, setChecked] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (request.current) void window.openkraken.cancel(request.current);
    };
  }, []);
  const leave = () => {
    if (pending) return;
    if (body && !result) setDiscard(true);
    else close();
  };
  const send = async () => {
    const id = crypto.randomUUID();
    request.current = id;
    setPending(true);
    setError('');
    try {
      const response = await window.openkraken.request({
        id,
        method: 'providerSubmitReview',
        accountId: context.accountId,
        options: {
          repository: context.repository,
          number: context.detail.number,
          revision: { head: context.detail.head.sha, base: context.detail.base.sha },
          event,
          body,
        },
      });
      if (response.kind === 'providerReviewSubmitted') {
        setResult(response.review);
        submitted();
      } else if (response.kind === 'error') {
        setError(response.message);
        setUncertain(response.code === 'PROVIDER_WRITE_UNCERTAIN');
        setConfirmed(false);
      } else if (response.kind === 'cancelled') {
        setError('Review cancelled before submission.');
        setConfirmed(false);
      }
    } catch {
      setError('The review result is unknown. Check submitted reviews before trying again.');
      setUncertain(true);
      setConfirmed(false);
    } finally {
      request.current = undefined;
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog pr-review-dialog"
      aria-label="Write pull-request review"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        leave();
      }}
    >
      <h2>Review #{context.detail.number}</h2>
      <p>
        {context.repository.owner}/{context.repository.name} · {context.detail.title}
      </p>
      <label>
        Review action
        <select
          aria-label="Review action"
          value={event}
          disabled={pending || confirmed || !!result || uncertain}
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'COMMENT' || value === 'APPROVE' || value === 'REQUEST_CHANGES')
              setEvent(value);
          }}
        >
          <option value="COMMENT">Comment</option>
          <option value="APPROVE" disabled={context.detail.draft}>
            Approve
          </option>
          <option value="REQUEST_CHANGES" disabled={context.detail.draft}>
            Request changes
          </option>
        </select>
      </label>
      <label>
        Review text
        <textarea
          rows={6}
          maxLength={65536}
          value={body}
          disabled={pending || confirmed || !!result || uncertain}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      {confirmed && (
        <section aria-label="Confirm review submission">
          <p>
            Send {event.replaceAll('_', ' ').toLowerCase()} for commit{' '}
            <code>{context.detail.head.sha}</code>?
          </p>
          <pre>{body || 'No review text.'}</pre>
          <p>This sends the review to the provider and can notify repository participants.</p>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">Review submitted for commit {result.commitId}.</p>}
      {uncertain && (
        <>
          <button
            onClick={() => {
              setChecking(true);
              setChecked(false);
            }}
          >
            Check submitted reviews
          </button>
          {checking && <PullReviews context={context} onLoaded={() => setChecked(true)} />}
          {checked && (
            <button
              onClick={() => {
                setUncertain(false);
                setChecking(false);
                setChecked(false);
                setError('');
              }}
            >
              I checked; return to draft
            </button>
          )}
        </>
      )}
      {discard ? (
        <section aria-label="Discard review draft">
          <p>Discard this unsent review text?</p>
          <button onClick={() => setDiscard(false)}>Keep editing</button>
          <button className="danger" onClick={close}>
            Discard draft
          </button>
        </section>
      ) : (
        <div className="dialog-actions">
          <button disabled={pending} onClick={leave}>
            Close review
          </button>
          {pending && (
            <button
              onClick={() => {
                if (request.current) void window.openkraken.cancel(request.current);
              }}
            >
              Cancel submission
            </button>
          )}
          {!result &&
            !uncertain &&
            (confirmed ? (
              <>
                <button disabled={pending} onClick={() => setConfirmed(false)}>
                  Edit review
                </button>
                <button disabled={pending} onClick={() => void send()}>
                  Submit review
                </button>
              </>
            ) : (
              <button
                disabled={pending || (event !== 'APPROVE' && !body.trim())}
                onClick={() => setConfirmed(true)}
              >
                Preview review
              </button>
            ))}
        </div>
      )}
    </dialog>
  );
}
export function WriteReview({
  context,
  submitted,
}: {
  context: PullContext;
  submitted: () => void;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button
        disabled={context.detail.state !== 'open' || context.detail.merged}
        onClick={() => setOpened(true)}
      >
        Write review
      </button>
      {opened && (
        <ReviewDialog context={context} close={() => setOpened(false)} submitted={submitted} />
      )}
    </>
  );
}
