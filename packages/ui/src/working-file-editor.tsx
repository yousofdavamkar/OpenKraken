import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import type { SaveWorkingFile, WorkingFile } from '@openkraken/ipc-contract';
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
          syntaxHighlighting(defaultHighlightStyle),
          /\.[cm]?[jt]sx?$/.test(path)
            ? javascript({ typescript: /\.[cm]?tsx?$/.test(path), jsx: /x$/.test(path) })
            : [],
          EditorView.theme(
            {
              '&': { height: '100%', backgroundColor: '#121b27', color: '#dae5f3' },
              '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace' },
              '.cm-gutters': { backgroundColor: '#182332', color: '#94a3b8' },
            },
            { dark: true },
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    editor.focus();
    return () => {
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
function Draft({
  file,
  busy,
  error,
  onClose,
  onSave,
}: {
  file: WorkingFile;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSave: (options: SaveWorkingFile) => Promise<boolean>;
}) {
  const [text, setText] = useState(normalize(file.text));
  const [newline, setNewline] = useState(file.newline === 'mixed' ? '' : file.newline);
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = text !== normalize(file.text) || (!!newline && newline !== file.newline);
  const close = () => {
    if (busy) return;
    if (dirty) setClosing(true);
    else onClose();
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
        <button disabled={busy} onClick={close}>
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
            disabled={busy}
            onChange={(event) => setNewline(event.target.value)}
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
          disabled={busy || !dirty || !newline || closing}
          onClick={() => {
            const output =
              newline === 'crlf'
                ? text.replace(/\n/g, '\r\n')
                : newline === 'cr'
                  ? text.replace(/\n/g, '\r')
                  : text;
            void onSave({ pathBytes: file.pathBytes, token: file.token, text: output }).then(
              (saved) => {
                if (saved) onClose();
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
      {error && <p role="alert">{error}</p>}
      {closing && (
        <div className="editor-close-review">
          <p>Discard unsaved changes?</p>
          <button onClick={() => setClosing(false)}>Keep editing</button>
          <button className="danger" onClick={onClose}>
            Discard draft
          </button>
        </div>
      )}
      <CodeEditor
        initial={normalize(file.text)}
        path={file.path}
        disabled={busy || closing}
        onChange={setText}
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
  const [file, setFile] = useState<WorkingFile>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    void window.openkraken
      .request({ id, method: 'workingFile', repoId, options: { pathBytes } })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setLoadError(result.message);
        if (result.kind === 'workingFile') setFile(result.file);
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [repoId, pathBytes]);
  return file ? (
    <Draft file={file} busy={busy} error={error} onClose={onClose} onSave={onSave} />
  ) : (
    <div role={loadError ? 'alert' : 'status'}>
      {loadError || 'Loading working file…'} <button onClick={onClose}>Cancel editor</button>
    </div>
  );
}
