# 0066 — Terminal shell integration

## Decision

The xterm parser consumes standard OSC 133 markers: A starts a prompt, B ends the prompt, C begins command output, and D finishes a command with an optional exit code. The terminal toolbar displays that state and retains the last reported exit code at the next prompt. No command text or output is persisted. Unknown markers and malformed or out-of-range exit codes are ignored; reported exit codes accept signed 32-bit integers to accommodate non-POSIX shells. xterm handles escape sequences spanning multiple output events, including BEL and ST terminators.

These sequences are untrusted display hints. They do not execute commands, change repositories, access files, or authorize any operation. They cannot mark a native session as closed or suppress close confirmation. Native process exit clears the display state, and each new session starts without integration state. Parser hooks are disposed with the terminal. A late successful open response cannot re-enable input after native exit.

## Verification

Real Electron UI acceptance emits split sequences through a native POSIX shell and verifies prompt, command and exit-code states, both terminators, malformed-marker handling, close confirmation after a completion marker, native exit cleanup and a fresh session. Existing terminal lifecycle, backpressure, focus and missing-shell tests pass with this behavior.

## References

- [OSC 133 markers](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)
- [xterm parser hooks and untrusted sequences](https://xtermjs.org/docs/guides/hooks/)
