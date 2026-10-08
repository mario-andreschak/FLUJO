# Bash MCP shell diagnostics

The Bash MCP executes a command in a selected shell. Use `shell_info` before relying on an interpreter or developer utility that may not be installed on the host.

On Windows, `shell: "default"` resolves in this order: PowerShell 7 (`pwsh`), Windows PowerShell 5.1, then `cmd.exe`. An explicit shell is normally never changed. The one compatible exception is an explicit `pwsh` request when PowerShell 7 is unavailable but Windows PowerShell 5.1 exists. The result reports:

```json
{
  "requestedShell": "pwsh",
  "shell": "powershell",
  "shellPath": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "shellSubstitution": {
    "requested": "pwsh",
    "used": "powershell",
    "reason": "PowerShell 7 (pwsh) is not installed on this machine."
  }
}
```

This is deliberately not a fallback to `cmd.exe`: the command continues to use a PowerShell dialect. Foreground, background, and PTY launches all consume the same resolved executable plan, and successful results expose that absolute executable as `shellPath`.

`shell_info.defaultShell` and `defaultShellPath` describe the ordinary default. A specific command requested with `shell: "default"` may still report `shellAutoSelected: true` when Windows PowerShell 5.1 would receive unquoted POSIX `&&` or `||`; this narrow compatibility rule prefers PowerShell 7 and then Git Bash. Explicit shell requests are never auto-selected.

Before executing, Bash MCP emits advisory `dialectWarnings` for command heads that are absent from `PATH`, including stages after a pipeline. It does not rewrite or block commands. On Windows, utilities such as `rg`, `head`, and `grep` may not be installed; install them, use the native equivalent, or choose an available POSIX shell. When a process exits with a common locale-independent “executable not found” status, its result also includes a hint pointing back to those warnings.

A requested `bash` must resolve to a real POSIX interpreter such as Git Bash. On Windows, every explicit Bash entry point launches the absolute Git Bash path reported by `shell_info`; callers should select `shell: "bash"` instead of invoking a bare `bash` from PowerShell. WSL relay launchers are not considered usable Bash interpreters because a machine can have the launcher but no installed Linux distribution. The unavailable-shell result tells callers to use `shell_info`; install Git for Windows or provision a WSL distro if Bash is required.

PowerShell source removes exactly one caller-supplied leading U+FEFF and is transported through `-EncodedCommand` as BOM-free UTF-16LE. This preserves nested quotes, Unicode, and literal `-c` text across the Windows process boundary. Encoding expands the command-line payload, so very large programs remain subject to the operating system's command-line size limit.

`write_stdin` preserves input bytes by default. For caller-generated code or text known to have acquired a leading BOM, pass `bomPolicy: "strip-leading"`; it removes exactly one leading UTF-8 BOM from that write. The policy is never enabled implicitly from the session shell because stdin may be application data.

