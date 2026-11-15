import { editorTheme } from './editor-theme.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { codeHighlighting, languageForPath } from './syntax.js';
import { WorkingFileDraftSession } from './working-file-draft.js';
import type { SaveWorkingFile, WorkingFile, WorkingFileDraft } from '@openkraken/ipc-contract';
const normalize = (text: string) => text.replace(/\r\n?|\n/g, '\n');
function CodeEditor({
  initial,
  path,
  disabled,
  onChange,
}: {
  initial: string;
  path: string;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView>(null);
  const editable = useRef(new Compartment());
  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    const language = new Compartment();
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          editable.current.of(EditorView.editable.of(true)),
          EditorView.contentAttributes.of({
            'aria-label': 'Working file text',
            role: 'textbox',
            'aria-multiline': 'true',
            spellcheck: 'false',
          }),
          codeHighlighting,
          language.of([]),
          editorTheme('100%'),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    void languageForPath(path)
      .then((support) => {
        if (alive) editor.dispatch({ effects: language.reconfigure(support) });
      })
      .catch(() => {});
    view.current = editor;
    editor.focus();
    return () => {
      alive = false;
      editor.destroy();
      view.current = null;
    };
  }, [initial, path, onChange]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!disabled)),
    });
  }, [disabled]);
  return <div ref={host} className="working-code-editor" />;
}
type Loaded = {
  file: WorkingFile;
  recovered: WorkingFileDraft | null;
  session: WorkingFileDraftSession;
  storageError?: string;
};
function Draft({
  loaded: { file, recovered, session, storageError },
  busy,
  error,
  onClose,
  onSave,
}: {
  loaded: Loaded;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSave: (options: SaveWorkingFile) => Promise<boolean>;
}) {
  const original = normalize(file.text);
  const originalNewline = file.newline === 'mixed' ? '' : file.newline;
  const initialText = recovered?.text ?? original;
  const [text, setText] = useState(initialText);
  const [newline, setNewline] = useState(recovered?.newline ?? originalNewline);
  const [closing, setClosing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [cleanupError, setCleanupError] = useState('');
  const [status, setStatus] = useState(recovered ? 'Recovered local draft' : '');
  const [edited, setEdited] = useState(false);
  const changeText = useCallback((next: string) => {
    setEdited(true);
    setText(next);
  }, []);
  const dialog = useRef<HTMLDialogElement>(null);
  const stale = !!recovered && recovered.token !== file.token;
  const dirty = stale || text !== original || newline !== originalNewline;
  const locked = busy || finishing || !!cleanupError;
  useEffect(() => {
    if (!edited || storageError) return;
    let live = true;
    setStatus('Saving draft…');
    session.change(
      dirty ? { token: recovered?.token ?? file.token, text, newline } : null,
      (message) => {
        if (live) setStatus(message);
      },
    );
    return () => {
      live = false;
    };
  }, [dirty, edited, file.token, newline, recovered, session, storageError, text]);
  const finish = async (discard: boolean) => {
    setFinishing(true);
    try {
      await session.close(discard);
      onClose();
    } catch (error) {
      setCleanupError(
        error instanceof Error ? error.message : 'The saved draft could not be cleared.',
      );
      setFinishing(false);
    }
  };
  useLayoutEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const close = () => {
    if (cleanupError) {
      onClose();
      return;
    }
    if (locked) return;
    if (dirty) setClosing(true);
    else void finish(true);
  };
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="reference-dialog working-editor-dialog"
      aria-label="Working file editor"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <h2>{file.path}</h2>
        <button disabled={busy || finishing} onClick={close}>
          Close editor
        </button>
      </header>
      <div className="comparison-toolbar">
        <span>
          {file.encoding}
          {file.bom ? ' · BOM' : ''}
          {dirty ? ' · Unsaved changes' : ''}
        </span>
        <label>
          Line endings
          <select
            aria-label="Line endings"
            value={newline}
            disabled={locked || closing}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'lf' || value === 'crlf' || value === 'cr') {
                setEdited(true);
                setNewline(value);
              }
            }}
          >
            <option value="" disabled>
              Choose format
            </option>
            <option value="lf">LF</option>
            <option value="crlf">CRLF</option>
            <option value="cr">CR</option>
          </select>
        </label>
        <button
          className="primary"
          disabled={locked || stale || !dirty || !newline || closing}
          onClick={() => {
            const output =
              newline === 'crlf'
                ? text.replace(/\n/g, '\r\n')
                : newline === 'cr'
                  ? text.replace(/\n/g, '\r')
                  : text;
            void onSave({ pathBytes: file.pathBytes, token: file.token, text: output }).then(
              (saved) => {
                if (saved) void finish(true);
              },
            );
          }}
        >
          Save file
        </button>
      </div>
      {file.newline === 'mixed' && (
        <p>Mixed line endings. Choose a line ending format before saving.</p>
      )}
      {stale && (
        <p role="alert">
          The file or checkout changed since this draft was captured. Copy the recovered text before
          discarding it and reopening the current file.
        </p>
      )}
      {storageError && <p role="alert">{storageError}</p>}
      {status && <p role="status">{status}</p>}
      {cleanupError && (
        <p role="alert">{cleanupError} The earlier draft may appear when you reopen this file.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {closing && (
        <div className="editor-close-review">
          <p>Discard unsaved changes?</p>
          <button onClick={() => setClosing(false)}>Keep editing</button>
          <button className="danger" disabled={finishing} onClick={() => void finish(true)}>
            Discard draft
          </button>
        </div>
      )}
      <CodeEditor
        initial={initialText}
        path={file.path}
        disabled={locked || closing}
        onChange={changeText}
      />
    </dialog>
  );
}
export function WorkingFileEditor({
  repoId,
  pathBytes,
  busy,
  error,
  onClose,
  onSave,
}: {
  repoId: string;
  pathBytes: string;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSave: (options: SaveWorkingFile) => Promise<boolean>;
}) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    const id = crypto.randomUUID();
    const session = new WorkingFileDraftSession();
    let alive = true;
    async function open() {
      const result = await window.openkraken.request({
        id,
        method: 'workingFile',
        repoId,
        options: { pathBytes },
      });
      if (!alive) return;
      if (result.kind !== 'workingFile')
        throw new Error(
          result.kind === 'error' ? result.message : 'Working file could not be opened.',
        );
      const file = result.file;
      try {
        const recovered = await session.open(repoId, pathBytes);
        if (alive) setLoaded({ file, session, recovered });
      } catch (error) {
        if (alive)
          setLoaded({
            file,
            session,
            recovered: null,
            storageError: error instanceof Error ? error.message : 'Local drafts are unavailable.',
          });
      }
    }
    void open().catch((error: unknown) => {
      if (alive) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
      void session.close(false).catch(() => {});
    };
  }, [repoId, pathBytes]);
  return loaded ? (
    <Draft loaded={loaded} busy={busy} error={error} onClose={onClose} onSave={onSave} />
  ) : (
    <div role={loadError ? 'alert' : 'status'}>
      {loadError || 'Loading working file…'} <button onClick={onClose}>Cancel editor</button>
    </div>
  );
}
