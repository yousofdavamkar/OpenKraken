import { useReviewDraft } from './review-draft.js';
import { editorTheme } from './editor-theme.js';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { PullComments } from './pull-comments.js';
import { pollNumberedPages, useProviderPoll } from './provider-polling.js';
import type {
  ProviderCommentTarget,
  ProviderPullComment,
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

function Patch({ text, context, path }: { text: string; context: PullContext; path: string }) {
  const [anchor, setAnchor] = useState<{ line: number; side: 'LEFT' | 'RIGHT' }>();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    setAnchor(undefined);
    const document = EditorState.create({ doc: text });
    const anchors = new Map<number, { line: number; side: 'LEFT' | 'RIGHT' }>();
    let oldLine = 0,
      newLine = 0,
      oldRemaining = 0,
      newRemaining = 0;
    for (let i = 1; i <= document.doc.lines; i++) {
      const line = document.doc.line(i).text;
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (header) {
        oldLine = Number(header[1]);
        oldRemaining = Number(header[2] ?? 1);
        newLine = Number(header[3]);
        newRemaining = Number(header[4] ?? 1);
      } else if (line.startsWith('-') && oldRemaining > 0) {
        anchors.set(i, { line: oldLine++, side: 'LEFT' });
        oldRemaining--;
      } else if (line.startsWith('+') && newRemaining > 0) {
        anchors.set(i, { line: newLine++, side: 'RIGHT' });
        newRemaining--;
      } else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
        anchors.set(i, { line: newLine++, side: 'RIGHT' });
        oldLine++;
        oldRemaining--;
        newRemaining--;
      } else if (!line.startsWith('\\')) {
        oldRemaining = 0;
        newRemaining = 0;
      }
    }
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
          EditorView.updateListener.of((update) => {
            if (update.selectionSet)
              setAnchor(
                anchors.get(update.state.doc.lineAt(update.state.selection.main.head).number),
              );
          }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': 'Provider patch', tabindex: '0' }),
          lineNumbers(),
          keymap.of(defaultKeymap),
          EditorView.decorations.of(Decoration.set(decorations)),
          editorTheme('300px'),
        ],
      }),
    });
    return () => view.destroy();
  }, [text]);
  return (
    <>
      <div ref={host} className="pr-patch" />
      {anchor ? (
        <>
          <p>
            Selected {anchor.side === 'LEFT' ? 'old' : 'new'} line {anchor.line} in {path}
          </p>
          <WriteComment context={context} target={{ kind: 'line', path, ...anchor }} />
        </>
      ) : (
        <p>Select a patch line to comment.</p>
      )}
    </>
  );
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
  const restoreScroll = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (restoreScroll.current !== undefined && scroll.current)
      scroll.current.scrollTop = restoreScroll.current;
    restoreScroll.current = undefined;
  }, [files]);
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
  }, [accountId, repository, detail.number, detail.head.sha, detail.base.sha, page, attempt]);
  useProviderPoll(
    pending,
    `${detail.number}/${detail.head.sha}/${detail.base.sha}/${page}/${attempt}`,
    async (read) => {
      const currentPath = files[active]?.path;
      const top = Math.floor((scroll.current?.scrollTop ?? 0) / 42);
      const anchor = files[top]?.path;
      const offset = (scroll.current?.scrollTop ?? 0) % 42;
      const result = await pollNumberedPages(
        page,
        async (page) => {
          const result = await read({
            method: 'providerPullFiles',
            accountId,
            options: {
              repository,
              number: detail.number,
              revision: { head: detail.head.sha, base: detail.base.sha },
              page,
            },
          });
          if (result.kind !== 'providerPullFiles')
            throw new Error('Changed files could not be refreshed.');
          return { ...result.page, items: result.page.files };
        },
        (file) => file.path,
      );
      return {
        commit: () => {
          const index = result.items.findIndex((file) => file.path === currentPath);
          const anchorIndex = result.items.findIndex((file) => file.path === anchor);
          restoreScroll.current =
            anchorIndex >= 0 ? anchorIndex * 42 + offset : scroll.current?.scrollTop;
          setFiles(result.items);
          setNext(result.nextPage);
          setLimited(result.limited);
          setError('');
          setActive(index >= 0 ? index : Math.max(0, Math.min(active, result.items.length - 1)));
          if (!result.items.some((file) => file.path === selected)) setSelected(undefined);
        },
      };
    },
  );
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
            <Patch key={file.path} text={file.patch} context={context} path={file.path} />
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
  useProviderPoll(pending, `${detail.number}/${page}/${attempt}`, async (read) => {
    const result = await pollNumberedPages(
      page,
      async (page) => {
        const result = await read({
          method: 'providerPullReviews',
          accountId,
          options: { repository, number: detail.number, page },
        });
        if (result.kind !== 'providerPullReviews')
          throw new Error('Reviews could not be refreshed.');
        return { ...result.page, items: result.page.reviews };
      },
      (review) => review.id,
    );
    return {
      commit: () => {
        setReviews(result.items);
        setNext(result.nextPage);
        setLimited(result.limited);
        setError('');
      },
    };
  });
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
  target,
}: {
  context: PullContext;
  target?: ProviderCommentTarget;
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
  const [result, setResult] = useState<ProviderPullReview | ProviderPullComment>();
  const noun = target ? 'comment' : 'review';
  const [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [checking, setChecking] = useState(false),
    [checked, setChecked] = useState(false);
  const cancelled = useRef(false);
  const [source] = useState(() => ({
    head: context.detail.head.sha,
    base: context.detail.base.sha,
  }));
  const [original, setOriginal] = useState(source);
  const stale =
    original.head !== context.detail.head.sha || original.base !== context.detail.base.sha;
  const scope = {
    accountId: context.accountId,
    repository: context.repository,
    number: context.detail.number,
  };
  const storage = useReviewDraft(scope, target ?? null, (draft) => {
    setOriginal(draft.source);
    setBody(draft.body);
    setEvent(draft.event);
    setUncertain(draft.uncertain);
    if (draft.uncertain)
      setError(
        'The provider may have received this submission. Check submitted results before trying again.',
      );
  });
  const draftValue = (text: string, action: ProviderSubmitReview['event'], unknown: boolean) =>
    text || action !== 'COMMENT' || unknown
      ? { body: text, event: action, source: original, uncertain: unknown }
      : null;
  const edit = (text: string, action: ProviderSubmitReview['event']) => {
    setBody(text);
    setEvent(action);
    storage.change(draftValue(text, action, false));
  };
  const [closeFailed, setCloseFailed] = useState(false);
  const closeDraft = async (remove: boolean) => {
    if (pending) return;
    setPending(true);
    try {
      if (remove) await storage.write(null);
      else await storage.flush();
      close();
    } catch {
      setPending(false);
      setCloseFailed(true);
      setError('The local draft could not be updated. Copy any text you want to keep.');
    }
  };
  const [unprotected, setUnprotected] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      cancelled.current = true;
      if (request.current) void window.openkraken.cancel(request.current);
    };
  }, []);
  const leave = () => {
    if (pending) return;
    if ((body || event !== 'COMMENT' || uncertain) && !result) setDiscard(true);
    else close();
  };
  const send = async () => {
    if (request.current || stale || !storage.ready) return;
    const id = crypto.randomUUID();
    cancelled.current = false;
    request.current = id;
    setPending(true);
    setError('');
    try {
      try {
        await storage.write(draftValue(body, event, true));
      } catch {
        if (!unprotected) {
          setUnprotected(true);
          setError(
            'The submission could not be recorded locally. Copy your text before submitting without crash recovery.',
          );
          return;
        }
      }
      if (cancelled.current) {
        await storage.write(draftValue(body, event, false)).catch(() => {});
        setConfirmed(false);
        setError('Cancelled before submission.');
        return;
      }
      setUnprotected(false);
      const common = { id, accountId: context.accountId };
      const options = {
        repository: context.repository,
        number: context.detail.number,
        revision: original,
        body,
      };
      const response = await window.openkraken.request(
        target
          ? { ...common, method: 'providerCreateComment', options: { ...options, target } }
          : { ...common, method: 'providerSubmitReview', options: { ...options, event } },
      );
      if (
        response.kind === 'providerReviewSubmitted' ||
        response.kind === 'providerCommentCreated'
      ) {
        setResult(response.kind === 'providerReviewSubmitted' ? response.review : response.comment);
        await storage
          .write(null)
          .catch(() => setError('Submitted. The local recovery copy could not be cleared.'));
        submitted();
      } else if (response.kind === 'error') {
        setError(response.message);
        const unknown = response.code === 'PROVIDER_WRITE_UNCERTAIN';
        setUncertain(unknown);
        if (!unknown) await storage.write(draftValue(body, event, false)).catch(() => {});
        setConfirmed(false);
      } else if (response.kind === 'cancelled') {
        await storage.write(draftValue(body, event, false)).catch(() => {});
        setError(`${target ? 'Comment' : 'Review'} cancelled before submission.`);
        setConfirmed(false);
      }
    } catch {
      setError(
        `The ${noun} result is unknown. Check submitted ${target ? 'comments' : 'reviews'} before trying again.`,
      );
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
      aria-label={target ? 'Write inline comment' : 'Write pull-request review'}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        leave();
      }}
    >
      <h2>
        {target ? 'Comment on' : 'Review'} #{context.detail.number}
      </h2>
      {target && (
        <p>
          {target.kind === 'reply'
            ? `Reply to thread #${target.commentId}`
            : `${target.path} · ${target.side} line ${target.line}`}
        </p>
      )}
      <p>
        {context.repository.owner}/{context.repository.name} · {context.detail.title}
      </p>
      {!target && (
        <label>
          Review action
          <select
            aria-label="Review action"
            value={event}
            disabled={!storage.ready || stale || pending || confirmed || !!result || uncertain}
            onChange={(e) => {
              const value = e.target.value;
              if (value === 'COMMENT' || value === 'APPROVE' || value === 'REQUEST_CHANGES')
                edit(body, value);
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
      )}
      <label>
        {target ? 'Comment text' : 'Review text'}
        <textarea
          rows={6}
          maxLength={65536}
          value={body}
          readOnly={stale}
          disabled={!storage.ready || pending || confirmed || !!result || uncertain}
          onChange={(e) => edit(e.target.value, event)}
        />
      </label>
      {!result && storage.status && <p>{storage.status}</p>}
      {stale && (
        <p>
          These commits have changed. The draft was written for {original.head}. Copy any text you
          want to reuse.
        </p>
      )}
      {confirmed && (
        <section aria-label={`Confirm ${noun} submission`}>
          <p>
            Send {target ? 'comment' : event.replaceAll('_', ' ').toLowerCase()} for commit{' '}
            <code>{context.detail.head.sha}</code>?
          </p>
          <pre>{body || 'No review text.'}</pre>
          <p>This sends the {noun} to the provider and can notify repository participants.</p>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <p role="status">
          {target ? 'Comment' : 'Review'} submitted for commit {result.commitId}.
        </p>
      )}
      {uncertain && (
        <>
          <button
            onClick={() => {
              setChecking(true);
              setChecked(false);
            }}
          >
            Check submitted {target ? 'comments' : 'reviews'}
          </button>
          {checking &&
            (target ? (
              <PullComments context={context} onLoaded={() => setChecked(true)} />
            ) : (
              <PullReviews context={context} onLoaded={() => setChecked(true)} />
            ))}
          {checked && (
            <button
              onClick={() => {
                storage.change(draftValue(body, event, false));
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
        <section aria-label={`Discard ${noun} draft`}>
          <p>Discard this unsent {noun} text?</p>
          <button
            disabled={pending}
            onClick={() => {
              setDiscard(false);
              setCloseFailed(false);
            }}
          >
            Keep editing
          </button>
          {closeFailed && (
            <button disabled={pending} onClick={close}>
              Close without saving these edits
            </button>
          )}
          <button disabled={pending} onClick={() => void closeDraft(false)}>
            Keep draft and close
          </button>
          <button className="danger" disabled={pending} onClick={() => void closeDraft(true)}>
            Discard draft
          </button>
        </section>
      ) : (
        <div className="dialog-actions">
          <button disabled={pending} onClick={leave}>
            Close {noun}
          </button>
          {pending && (
            <button
              onClick={() => {
                cancelled.current = true;
                if (request.current) void window.openkraken.cancel(request.current);
              }}
            >
              Cancel submission
            </button>
          )}
          {!result &&
            storage.ready &&
            !stale &&
            !uncertain &&
            (confirmed ? (
              <>
                <button
                  disabled={pending}
                  onClick={() => {
                    setConfirmed(false);
                    setUnprotected(false);
                  }}
                >
                  Edit {noun}
                </button>
                <button disabled={pending} onClick={() => void send()}>
                  {unprotected ? 'Submit without crash recovery' : `Submit ${noun}`}
                </button>
              </>
            ) : (
              <button
                disabled={pending || ((!!target || event !== 'APPROVE') && !body.trim())}
                onClick={() => setConfirmed(true)}
              >
                Preview {noun}
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

export function WriteComment({
  context,
  target,
}: {
  context: PullContext;
  target: ProviderCommentTarget;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button
        disabled={context.detail.state !== 'open' || context.detail.merged}
        onClick={() => setOpened(true)}
      >
        Comment on selected line
      </button>
      {opened && (
        <ReviewDialog
          context={context}
          target={target}
          close={() => setOpened(false)}
          submitted={() => {}}
        />
      )}
    </>
  );
}
export function CommentDiscussion({ context }: { context: PullContext }) {
  const [target, setTarget] = useState<ProviderCommentTarget>();
  const [version, setVersion] = useState(0);
  return (
    <>
      <PullComments
        key={version}
        context={context}
        onReply={(commentId) => setTarget({ kind: 'reply', commentId })}
      />
      {target && (
        <ReviewDialog
          context={context}
          target={target}
          close={() => setTarget(undefined)}
          submitted={() => setVersion((value) => value + 1)}
        />
      )}
    </>
  );
}
