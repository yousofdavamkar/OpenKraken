# 0073 — Interrupted native prompts

## Problem

A Git-service crash resolved outstanding requests as errors, but the native document editor followed the repository's busy flag and unmounted immediately. Text edited in that dialog disappeared. The crash error also encouraged retrying without first checking whether a write had partially completed.

## Decision

Main emits a strict `gitRequestsInterrupted` event containing only the affected request UUIDs before resolving service-exit errors. The service-response deadline emits the same event before requesting cancellation and returning a timeout. The list is bounded to eight, matching main's admission limit. The renderer cannot invoke this event, and main rejects it if sent by the Git utility. No document contents, credentials or repository paths enter the event.

The native editor now stays mounted until its service closes the prompt or the user explicitly discards interrupted text. An interruption keeps the existing textarea state, explains that saving was not confirmed, removes native Save/Cancel actions and offers **Discard unsaved draft**. Escape leaves it open. Window close/reload uses the existing unsaved-changes confirmation. A later editor-close event does not erase an already-interrupted draft. Copying is an ordinary user selection/copy action; the app does not automatically write the text to a file, clipboard or new Git operation.

Authentication prompts for interrupted requests are removed, releasing their component state. Replies retain their original operation and prompt IDs; a replacement service rejects those stale capabilities. Native editor/authentication writes are never retried automatically. Service-exit and timeout messages state that partial completion is possible and ask the user to inspect the repository or remote before retrying.

This is in-memory recovery for a surviving renderer. It does not persist native-editor drafts across renderer or main-process death. Closing/discarding loses the retained text. Saving may already have occurred before a connection failed; the UI does not claim otherwise. Durable editor drafts, transaction recovery and lock reconciliation remain separate M8 work.

## Verification

An Electron pre-rebase-hook fixture reproduced lost editor text on service death before the change. It now retains the edited text and original native file/HEAD, removes Save and continue, survives Escape and a canceled native window close, and requires explicit discard. The replacement service refuses the old editor reply. Normal native-editor Save/Cancel and interactive-rebase flows pass alongside it.

A native HTTP authentication fixture kills the service with a password typed but not submitted. The prompt disappears, the interrupted operation reports uncertainty, and a replacement service refuses the stale secret without sending an Authorization header. Contract tests bound interruption identities and reject extra payload data. The service-exit path is exercised with real process termination; the long service-deadline path shares the event helper but is not separately advanced through its full timeout in these fixtures.

Separate Linux fixtures kill the main app during a stalled native fetch, verify transport closure before the test server releases it, restart with an unknown activity outcome and recover an acknowledged commit draft. Main-app and terminal-utility death also terminate the PTY shell and an ordinary foreground command. Fixture cleanup checks process creation identity before signaling remaining owned PIDs. These tests do not prove cleanup of deliberately detached or signal-ignoring terminal programs, cross-platform behavior, arbitrary interrupted writes or remote outcomes. Native Git command supervision remains described in [0071](0071-native-process-supervision.md).
