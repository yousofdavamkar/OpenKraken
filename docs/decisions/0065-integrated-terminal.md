# 0065 — Integrated terminal

## Decision

The terminal runs `node-pty` in a dedicated Electron utility process, separate from Git and the sandboxed renderer. It starts only after an explicit terminal-open request for the repository currently known to main. The renderer supplies a session UUID and bounded dimensions; it cannot supply an executable, arguments, environment or working directory. Main supplies the repository path from a validated Git snapshot. The host selects an absolute `SHELL`/account shell on POSIX or `ComSpec` on Windows, with an OS fallback. The shell runs with the user's normal permissions and configuration.

One terminal session is supported initially. Its working directory remains associated with the repository where it started even if the graph later changes repositories. Main rejects input for ended or foreign sessions. Reload, renderer failure and window close end the terminal utility. Native shell exit status is delivered without automatically restarting the shell. Input and output are not added to application logs or profile settings; shell-managed history remains governed by the user's shell configuration.

Typed requests use the existing sender-validated bridge. They never enter the Git service. Output events come only from the corresponding terminal host; Git-origin terminal events are discarded. Data chunks are bounded to 16,384 UTF-16 code units and preserve surrogate pairs; input chunks are limited to 8,192. The utility pauses reads at 256 Ki characters or 256 unacknowledged chunks and resumes below half those thresholds. Cumulative sequence acknowledgments follow rendering, preventing uncontrolled buffering across IPC. Acknowledgments use a separate path from the Git/provider pending-operation limit.

The native package remains external to the bundle. Packaging includes its runtime dependencies and unpacks the package's native libraries and helper executables alongside the existing authentication helper. Linux source builds require a C++ compiler. Platform-specific runtime acceptance remains necessary.

## References

- [Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process)
- [node-pty API and platform support](https://github.com/microsoft/node-pty)
- [xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/)
- [xterm security considerations](https://xtermjs.org/docs/guides/security/)

## Verification

Real Electron acceptance opens a fixture repository, verifies separate Git and terminal utility processes, sends shell input, observes the repository working directory, resizes the native terminal, reads its exit code, and rejects a stale session or unknown repository. Contract tests reject arbitrary paths, shell settings, malformed sessions and oversized input/dimensions. UI, packaging, lifecycle and shell-integration acceptance will be added with their implementation slices.
