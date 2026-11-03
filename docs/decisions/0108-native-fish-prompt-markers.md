# 0108 — Native fish prompt markers

Fish has native OSC 133 integration through its `mark-prompt` feature, enabled by default from fish 4. OpenKraken starts the user's fish normally and consumes those markers; it does not replace `fish_prompt`, install event handlers, rewrite configuration or override an explicit `no-mark-prompt` setting. Older fish versions can opt into their native feature. Automatic zsh and PowerShell setup remains separate work.

The Linux fish 4.2.1 acceptance test reproduced the terminal toolbar reporting integration unavailable despite a working shell. A native PTY probe showed `A;click_events=1`, `C;cmdline_url=false`, and `D;1`. The renderer previously recognized only bare A/B/C markers.

The parser now recognizes A/B/C followed by zero or more semicolon-separated `name=value` parameters. Names use ASCII letters/underscore followed by letters/digits/underscore; values cannot contain a semicolon or a Unicode control character. Values are discarded. In particular, `click_events` does not enable click actions and `cmdline_url` is not decoded, executed, retained as progress state or persisted. Malformed parameter fields remain ignored. Existing D/exit-code validation and the native session-exit authority are unchanged.

Fish 4.2.1 did not emit B in the native probe, so A remains the **Prompt** state rather than claiming that the prompt has ended. That state now also shows the last reported exit code. Shells that emit B continue to show **Ready for command**. The first prompt has no invented exit status.

Real Electron acceptance covers native fish defaults, explicit enable and explicit opt-out; custom prompt and pre/post-execution hooks; `$status` and `$pipestatus`; a slow failed command; pipeline results; hide/reopen; native exit; and unchanged configuration bytes. The parameterized marker regression also fails on the previous build and verifies both BEL/ST terminators alongside malformed-marker and close-confirmation behavior. Linux CI installs fish and verifies its presence; the default-feature case skips fish versions before 4 while explicit feature cases still run. `OPENKRAKEN_FISH` can select a separately installed executable for acceptance without changing the system shell.

Local evidence uses fish 4.2.1 from Ubuntu package `4.2.1-3.2`, extracted under the local tool cache without a system installation. This does not establish fish behavior on macOS, every older release or all third-party prompt plugins. No shell script injection is needed for this native integration.

References: [fish feature flags and native prompt marking](https://fishshell.com/docs/current/language.html#feature-flags), [fish terminal marker implementation](https://github.com/fish-shell/fish-shell/blob/master/src/terminal.rs), and [ADR 0066](0066-terminal-shell-integration.md).
