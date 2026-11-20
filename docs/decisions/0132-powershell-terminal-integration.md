# PowerShell terminal integration

When the configured terminal executable is `pwsh` or `pwsh.exe`, the PTY host starts it with `-NoExit -File` and the bundled startup script. PowerShell loads its normal profiles before the script. The host supplies the file path as a separate argument. Windows uses the existing shell selection, and PowerShell applies its execution policy.

The script supports PowerShell 7 with PSReadLine. It captures the installed prompt and line reader and delegates to both. After PSReadLine accepts a nonblank line, the wrapper emits the OSC 133 command-start marker. On the next prompt it reports completion, then brackets the prompt text. The first prompt has no previous command result. Original prompt code can read the previous pipeline’s success flag, and the next command can read both that flag and the native exit code.

For a successful pipeline the marker carries zero. For a failure the wrapper checks the most recent error against the history entry. It reports one for a PowerShell error and reports the native exit code for an external program when available. PowerShell retains the last external exit code across cmdlets, so reading that variable alone can misreport a cmdlet failure. The integration keeps its bookkeeping in the shell process and leaves user profile and history settings in place. Read-only hooks, a replacement line reader, restricted language mode or an existing installation retain the configured behavior.

A signed Windows package signs the startup script before Electron records its digest in the ASAR. Bundle and MSI verification check both the digest and the pinned publisher. The Linux package tests run the unpacked script in an interactive PTY. Native Windows verification requires a Windows runner.

[Microsoft’s OSC 133 shell integration reference](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration) · [Microsoft SDK signing formats](https://learn.microsoft.com/en-us/windows/win32/seccrypto/cryptography-tools)
