# 0071 — Native command supervision

## Problem and decision

Killing the Git utility interrupted IPC but left an active native fetch and its transport process alive. The existing runner's timeout and process-group cancellation lived in the utility that had died. A main-owned list of numeric child PIDs would add startup/retirement races and PID-reuse risks.

The Git utility now configures the existing native helper as a supervisor before Git discovery, repository work or watcher commands begin. Each runner invocation starts the helper with the owning utility PID, executable and argument vector, without a shell. The renderer cannot set this configuration. Existing working-directory/environment isolation, output limits, deadlines and cancellation remain in the runner. Askpass and editor modes retain their existing protocol and deadlines; supervisor mode uses the runner's deadline instead of the helper's three-minute prompt deadline.

The helper forwards stdin directly and streams stdout/stderr through bounded copying loops without collecting output. Go waits for those copying loops, retaining the supervisor while ordinary descendants hold the output streams after the direct command exits. Native exit codes are retained; a signal exit is non-success, and startup/streaming/supervision failures return 125 with a fixed diagnostic.

## Platform ownership

On POSIX systems the helper must already be its own process-group leader, created by the runner's detached spawn. It verifies its actual parent before launching the command and checks reparenting every 25 ms. On parent loss it kills its own group, including itself and ordinary descendants. Its still-live identity prevents reuse of that group ID. It ignores broken-pipe termination so output to a dead owner cannot bypass cleanup. On a runner termination signal it stays alive for up to 100 ms before forcibly terminating the group, covering descendants that ignore termination; the runner retains its own escalation deadline.

This is process-lifetime management, not a sandbox for native Git hooks or helpers. POSIX programs that intentionally leave the group or daemonize outside the active command's stream lifetime are not contained. The monitor interval is not a hard real-time guarantee.

On Windows the helper opens a synchronization/query handle to its parent, checks that it is alive and older than the helper, then joins a private Job Object before spawning Git. Ordinary children inherit job membership. The job disables breakaway and uses kill-on-close; parent-handle signaling terminates the job. Normal completion terminates the job with the command's exit code. The open handle retains the parent's identity across numeric PID reuse. Setup failure refuses to launch Git. Windows/macOS cross-compilation does not establish runtime acceptance.

## Verification and limits

A desktop regression first reproduced the leak by observing a still-open local HTTP fetch after killing the Git utility. It now observes transport closure without releasing the fixture server and successfully reopens the repository through a replacement service. A Linux hook fixture verifies termination of a signal-ignoring hook and descendant, retaining HEAD/index/staged content. Native runner tests cover binary stdin, streamed stdout/stderr, literal arguments, exit codes, unavailable executables, output limits, timeouts, parser failures and cancellation after the direct command has exited but a descendant retains output streams.

Activity still reports an interrupted operation as unknown. Stopping processes does not roll back writes, prove a remote write failed, remove every native lock or justify an automatic retry. Durable write recovery and broader crash testing remain M8 requirements.

## Public references

- [Go command execution and stream-copy lifetime](https://pkg.go.dev/os/exec#Cmd)
- [POSIX parent identity and reparenting](https://www.man7.org/linux/man-pages/man2/getpid.2.html)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Nested Windows jobs and inherited membership](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
- [Windows extended job limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
- [Windows process creation times](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
