import { NativeDraftRecovery } from './native-draft-recovery.js';
import { subscribeDesktopEvents } from './desktop-events.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DesktopEvent } from '@openkraken/ipc-contract';
type Prompt = Extract<DesktopEvent, { type: 'editorPrompt' }> & { interrupted?: boolean };
function EditorDialog({ prompt, discard }: { prompt: Prompt; discard: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(prompt.text);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const version = useRef(0);
  const saveError = useRef('');
  const admitted = useRef<Promise<void>>(Promise.resolve());
  const dirty = text !== prompt.text;
  const closing = useRef(false);
  const persist = (value: string, edit: number) => {
    const save = async () => {
      try {
        const result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'nativeDraftWrite',
          requestId: prompt.id,
          promptId: prompt.promptId,
          text: value === prompt.text ? null : value,
        });
        if (result.kind !== 'nativeDraftUpdated')
          throw new Error(
            result.kind === 'error' ? result.message : 'Draft save was not confirmed.',
          );
        saveError.current = '';
        if (edit === version.current) setStatus(value === prompt.text ? '' : 'Draft saved locally');
      } catch (error) {
        saveError.current =
          error instanceof Error ? error.message : 'Draft save was not confirmed.';
        if (edit === version.current) setStatus(saveError.current);
      }
    };
    admitted.current = admitted.current.then(save);
    return admitted.current;
  };
  const change = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    const edit = ++version.current;
    if (value.includes('\0') || new TextEncoder().encode(value).length > 1048576) {
      setStatus('Draft exceeds the Git editor limit.');
      return;
    }
    setStatus('Saving draft…');
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void persist(value, edit);
    }, 250);
  };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      version.current++;
    },
    [],
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useLayoutEffect(() => {
    if (!prompt.interrupted && !dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      if (closing.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [prompt.interrupted, dirty]);
  const respond = async (value: string | null) => {
    if (pending || prompt.interrupted) return;
    setPending(true);
    setError('');
    try {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        timer.current = undefined;
        if (value !== null) await persist(value, version.current);
      }
      await admitted.current;
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'answerEditor',
        requestId: prompt.id,
        promptId: prompt.promptId,
        text: value,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'editorAnswered' && !result.accepted)
        throw new Error(
          'This editor request is no longer active. Review the current Git operation.',
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const dismiss = async (remove: boolean, skipSave = false) => {
    setPending(true);
    clearTimeout(timer.current);
    try {
      if (!remove && !skipSave) {
        if (invalid)
          throw new Error(
            'Copy the document text before closing. This draft exceeds the Git editor limit.',
          );
        await persist(text, ++version.current);
        if (saveError.current) throw new Error(saveError.current);
      } else await admitted.current;
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'nativeDraftDismiss',
        requestId: prompt.id,
        promptId: prompt.promptId,
        discard: remove,
      });
      if (result.kind !== 'nativeDraftUpdated' && !skipSave)
        throw new Error(
          result.kind === 'error' ? result.message : 'Closing the draft was not confirmed.',
        );
      closing.current = true;
      discard();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setPending(false);
    }
  };
  const invalid = text.includes('\0') || new TextEncoder().encode(text).length > 1048576;
  return (
    <dialog
      ref={dialog}
      className="reference-dialog git-editor-dialog"
      aria-label="Git document editor"
      onCancel={(event) => {
        event.preventDefault();
        if (!prompt.interrupted) void respond(null);
      }}
    >
      <h2>Git document editor</h2>
      {prompt.interrupted ? (
        <p role="alert">
          The Git operation was interrupted. Saving this text was not confirmed. Copy your text
          before discarding this draft, then inspect the repository before retrying.
        </p>
      ) : (
        <p>Git requested an additional text document. Review your changes before continuing.</p>
      )}
      <code>{prompt.path}</code>
      <label>
        Document text
        <textarea
          autoFocus
          aria-label="Document text"
          rows={18}
          maxLength={1048576}
          spellCheck={false}
          disabled={pending}
          value={text}
          onChange={(event) => change(event.target.value)}
        />
      </label>
      {status && <p role="status">{status}</p>}
      {!prompt.interrupted && (
        <NativeDraftRecovery
          requestId={prompt.id}
          promptId={prompt.promptId}
          useText={change}
          disabled={pending}
        />
      )}
      {invalid && <p role="alert">Enter text of at most 1 MiB without NUL bytes.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        {prompt.interrupted ? (
          <>
            <button disabled={pending} onClick={() => void dismiss(false)}>
              Keep draft and close
            </button>
            <button disabled={pending} onClick={() => void dismiss(true)}>
              Discard unsaved draft
            </button>
            {error && (
              <button disabled={pending} onClick={() => void dismiss(false, true)}>
                Close without saving these edits
              </button>
            )}
          </>
        ) : (
          <>
            <button disabled={pending} onClick={() => void respond(null)}>
              Cancel edit
            </button>
            <button
              className="primary"
              disabled={pending || invalid}
              onClick={() => void respond(text)}
            >
              Save and continue
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
export function GitEditors() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  useEffect(
    () =>
      subscribeDesktopEvents((event) => {
        if (event.type === 'editorPrompt')
          setPrompts((current) => [
            ...current.filter((item) => item.promptId !== event.promptId),
            event,
          ]);
        if (event.type === 'editorClosed')
          setPrompts((current) =>
            current.filter((item) => item.promptId !== event.promptId || item.interrupted),
          );
        if (event.type === 'gitRequestsInterrupted')
          setPrompts((current) =>
            current.map((item) =>
              event.requestIds.includes(item.id) ? { ...item, interrupted: true } : item,
            ),
          );
      }),
    [],
  );
  // Keep the same dialog mounted until the service closes it or the user discards
  // interrupted text. Clearing the operation's busy flag must not erase a draft.
  const prompt = prompts[0];
  return prompt ? (
    <EditorDialog
      key={prompt.promptId}
      prompt={prompt}
      discard={() =>
        setPrompts((current) => current.filter((item) => item.promptId !== prompt.promptId))
      }
    />
  ) : null;
}
