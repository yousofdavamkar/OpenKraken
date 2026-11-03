# 0066 — Terminal shell integration

## Decision

The xterm parser consumes standard OSC 133 markers: A starts a prompt, B ends the prompt, C begins command output, and D finishes a command with an optional exit code. The terminal toolbar displays that state and retains the last reported exit code at the next prompt. No command text or output is persisted. Unknown markers and malformed or out-of-range exit codes are ignored; reported exit codes accept signed 32-bit integers to accommodate non-POSIX shells. xterm handles escape sequences spanning multiple output events, including BEL and ST terminators.

These sequences are untrusted display hints. They do not execute commands, change repositories, access files, or authorize any operation. They cannot mark a native session as closed or suppress close confirmation. Native process exit clears the display state, and each new session starts without integration state. Parser hooks are disposed with the terminal. A late successful open response cannot re-enable input after native exit.

For a POSIX executable named `bash`, the host supplies a bundled rcfile. It first sources the user's normal `.bashrc`; it does not edit that file or start a login shell. Bash 5.1 or newer gets automatic integration. Older Bash versions, disabled prompt expansion, and read-only prompt variables retain normal shell behavior without injected markers. Other shells can supply their own standard OSC 133 sequences; automatic zsh, fish and PowerShell setup is not implemented by this decision.

The integration appends a C marker to PS0 and a final hook to scalar or array PROMPT_COMMAND, including exported arrays. It wraps the current PS1 after the user's hooks, removing only its own prior wrapper on subsequent prompts. Existing prompt commands, custom prompt text, PS0 and DEBUG traps remain in place. The D marker samples status during PS1 expansion, when Bash has restored the command's `$?` and `PIPESTATUS`; inserting a hook before user prompt commands would disturb their pipeline status. Markers have nonprinting prompt delimiters so Readline can count the displayed prompt width. The first prompt has no fabricated previous-command exit status.

Builds copy the script beside the terminal service; packaging unpacks it so the external shell can read it. The shell script path and startup arguments come from the host, never from renderer requests. No temporary shell startup file or per-session script is written into the repository or the user's profile.

## Verification

Real Electron UI acceptance emits split sequences through a native POSIX shell and verifies prompt, command and exit-code states, both terminators, malformed-marker handling, close confirmation after a completion marker, native exit cleanup and a fresh session. Existing terminal lifecycle, backpressure, focus and missing-shell tests pass with this behavior.

Linux Bash acceptance uses isolated shell profiles and native PTYs. Scalar, array and exported-array fixtures preserve dynamic custom prompts, PS0, DEBUG traps, hook order, failed-command status and multi-command PIPESTATUS. Hiding retains progress and native exit clears it. The Linux packaged smoke check uses the unpacked Bash rcfile and verifies initial prompt detection, a failed command, native Ctrl+P delivery and native shell exit. These checks do not establish cross-platform or other-shell runtime acceptance.

Fallback fixtures disable prompt expansion or mark PS1 read-only with `set -eu` enabled. Both retain a working prompt, execute commands, and exit normally without integration. Early compatibility returns explicitly succeed so declining integration does not trigger the user's errexit setting.

## References

- [OSC 133 markers](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)
- [xterm parser hooks and untrusted sequences](https://xtermjs.org/docs/guides/hooks/)
