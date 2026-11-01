# 0001 — M0 architecture and scope

Accepted 2026-11-01. Source: reconstruction blueprint §§1–5 and the implementation brief.

The requested deliverable is the six explicit M0/start-of-M1 tasks. Tabs, durable preferences, URI commands, watchers, secrets, undo, updates, and advanced graph controls remain later work. There are no credentials or undo records in M0.

Pin React 19.3.1, React DOM 19.3.1, TypeScript 7.0.2 and Electron 45.2.1, the registry stable releases checked at implementation time. TypeScript project references check all runtime packages; esbuild bundles Node entrypoints and Vite bundles the renderer. ESLint uses Babel syntax parsing so it does not depend on the legacy TypeScript compiler API. Prettier formats implementation files only.

Use one sandboxed window, one Git utility process, one validated request channel, and operation-specific schemas. The renderer receives repository IDs and data, never a general filesystem or subprocess API. Folder selection and initialization are native dialogs. Main validates the exact top-level sender frame and document URL. Network access, navigation, new windows and permissions are denied. CSP allows local scripts and workers; style attributes are allowed for virtual row geometry, never inline scripts/eval.

Development runs the built local files with the same CSP as production. Packaging uses ASAR and flips RunAsNode off, Node CLI inspection off, embedded ASAR validation on, and ASAR-only loading on. Packaged fuse verification is separate from the developer Electron binary used by Playwright.

No shipped proprietary artifacts, extraction directories, or notes are implementation inputs. Existing analysis and numbered files are preserved and excluded from implementation commits.
