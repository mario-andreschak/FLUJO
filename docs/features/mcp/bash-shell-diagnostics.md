# Bash MCP shell diagnostics

The Bash MCP executes a command in a selected shell. Use `shell_info` before relying on an interpreter or developer utility that may not be installed on the host.

On Windows, `shell: "default"` resolves in this order: PowerShell 7 (`pwsh`), Windows PowerShell 5.1, then `cmd.exe`. An explicit shell is normally never changed. The one compatible exception is an explicit `pwsh` request when PowerShell 7 is unavailable but Windows PowerShell 5.1 exists. The result reports:

```json
{
  "requestedShell": "pwsh",
  "shell": "powershell",
  "shellSubstitution": {
    "requested": "pwsh",
    "used": "powershell",
    "reason": "PowerShell 7 (pwsh) is not installed on this machine."
  }
}
```

This is deliberately not a fallback to `cmd.exe`: the command continues to use a PowerShell dialect. Windows PowerShell 5.1 does not accept `&&` and `||` as statement separators; returned `dialectWarnings` explain compatible alternatives.

Before executing, Bash MCP emits advisory `dialectWarnings` for command heads that are absent from `PATH`, including stages after a pipeline. It does not rewrite or block commands. On Windows, utilities such as `rg`, `head`, and `grep` may not be installed; install them, use the native equivalent, or choose an available POSIX shell. When a process exits with a common locale-independent “executable not found” status, its result also includes a hint pointing back to those warnings.

A requested `bash` must resolve to a real POSIX interpreter such as Git Bash. WSL relay launchers are not considered usable Bash interpreters because a machine can have the launcher but no installed Linux distribution. The unavailable-shell result tells callers to use `shell_info`; install Git for Windows or provision a WSL distro if Bash is required.
