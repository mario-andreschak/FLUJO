; flujo-setup.iss - builds flujo-setup.exe, a graphical wizard around
; scripts\install.ps1.
;
; The exe is a BOOTSTRAPPER, not a classic file-copying installer: the wizard
; collects the same answers install.ps1 would ask interactively (install
; folder, desktop shortcut, Ollama, execution policy), then runs install.ps1
; unattended by passing those answers through the FLUJO_* environment
; variables. All the real work - checking for Git / Node.js / Python / uv / ripgrep,
; installing what is missing via winget, cloning the repo, building, and
; registering the global 'flujo' command - lives in install.ps1, so the
; one-liner installer and this exe can never drift apart.
;
; Re-running the exe on an existing install updates it (same as re-running the
; one-liner). Uninstalling is handled by scripts\uninstall.ps1 (see readme),
; not by Inno Setup's own uninstaller - no uninstaller is registered here.
;
; Compile:  ISCC.exe flujo-setup.iss            (Inno Setup 6)
;           ISCC.exe /DMyAppVersion=1.2.3 flujo-setup.iss
; CI builds this automatically - see .github/workflows/installer.yml.

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#ifndef MyBranch
  #define MyBranch "main"
#endif
#define MyAppName "FLUJO"
#define MyAppURL "https://github.com/mario-andreschak/FLUJO"

[Setup]
AppId={{B37F6D1D-6C0E-4A0A-9F2A-6E2C2E3E6C4F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=flujo-app
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
DefaultDirName={localappdata}\FLUJO
DirExistsWarning=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
WizardStyle=modern
OutputDir=Output
OutputBaseFilename=flujo-setup
Uninstallable=no
SetupLogging=yes

[Files]
; Carried inside the exe, extracted to {tmp} at install time and run from
; there. Deliberately NOT placed into {app}: install.ps1 git-clones into {app},
; and git clone requires the target directory to be empty.
Source: "..\scripts\install.ps1"; Flags: dontcopy
Source: "..\scripts\installer-functions.ps1"; Flags: dontcopy

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"
Name: "ollama"; Description: "Install Ollama for local models (large download, optional)"; Flags: unchecked

[Run]
; Finish-page checkbox. The 'flujo' launcher is written by install.ps1; it
; runs `npm start` and opens the browser.
Filename: "{localappdata}\FLUJO-cli\flujo.cmd"; Description: "Start FLUJO now"; \
  Flags: postinstall nowait shellexec skipifsilent; Check: FlujoLauncherExists

[Messages]
WelcomeLabel2=This will install [name] on your computer - including anything it needs that is missing (Git, Node.js, Python, uv, and ripgrep).%n%nIt is recommended that you close all other applications before continuing.

[Code]
function SetEnvironmentVariable(lpName: string; lpValue: string): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function FlujoLauncherExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\FLUJO-cli\flujo.cmd'));
end;

procedure SetRequiredEnvironmentVariable(Name: string; Value: string);
begin
  if not SetEnvironmentVariable(Name, Value) then
    RaiseException('Could not prepare the installer environment variable ' + Name + '. Setup has stopped before running PowerShell.');
end;

// install.ps1 bootstraps every prerequisite through winget, so winget itself
// is the only thing setup must insist on up front.
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if not Exec('cmd.exe', '/c where winget >nul 2>nul', '', SW_HIDE,
              ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    MsgBox('winget (App Installer) was not found.' + #13#10#13#10 +
           'FLUJO uses winget to install its prerequisites (Git, Node.js, Python, uv, ripgrep).' + #13#10 +
           'Install "App Installer" from the Microsoft Store, then run this setup again.',
           mbCriticalError, MB_OK);
    Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;

  // Hand the wizard's answers to install.ps1 via its unattended-install
  // environment variables (inherited by the Exec'd process below).
  SetRequiredEnvironmentVariable('FLUJO_DIR', ExpandConstant('{app}'));
  SetRequiredEnvironmentVariable('FLUJO_BRANCH', '{#MyBranch}');
  if WizardIsTaskSelected('desktopicon') then
    SetRequiredEnvironmentVariable('FLUJO_SHORTCUT', '1')
  else
    SetRequiredEnvironmentVariable('FLUJO_SHORTCUT', '0');
  if WizardIsTaskSelected('ollama') then
    SetRequiredEnvironmentVariable('FLUJO_OLLAMA', '1')
  else
    SetRequiredEnvironmentVariable('FLUJO_OLLAMA', '0');
  // Never start from inside install.ps1 (it would block this wizard forever);
  // the finish page's "Start FLUJO now" checkbox launches it detached instead.
  SetRequiredEnvironmentVariable('FLUJO_START', '0');

  // FLUJO runs npm/npx (PowerShell shims) on every start and when building MCP
  // servers on demand, so persisting the execution policy is worthwhile here.
  // Same consent question install.ps1 would ask on a terminal.
  if MsgBox('Windows blocks running PowerShell scripts by default, and FLUJO needs to run npm/npx (PowerShell shims) for this install and later when building MCP servers.' + #13#10#13#10 +
            'Set the execution policy to RemoteSigned for your user account? (recommended)',
            mbConfirmation, MB_YESNO) = IDYES then
    SetRequiredEnvironmentVariable('FLUJO_SET_POLICY', '1')
  else
    SetRequiredEnvironmentVariable('FLUJO_SET_POLICY', '0');

  ExtractTemporaryFile('installer-functions.ps1');
  ExtractTemporaryFile('install.ps1');
  WizardForm.StatusLabel.Caption :=
    'Running the FLUJO installer - a console window shows its progress ...';

  if not Exec('powershell.exe',
              '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}') + '\install.ps1"',
              '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
    RaiseException('Could not start PowerShell to run the installer.');

  if ResultCode <> 0 then
    RaiseException('The FLUJO installer did not finish (exit code ' + IntToStr(ResultCode) + ').' + #13#10#13#10 +
                   'The console window shows the reason. Common causes: a freshly installed prerequisite ' +
                   '(Git/Node/Python/uv) needing a new terminal to appear on PATH, or a build failure.' + #13#10 +
                   'Fix the issue shown, then run this setup again - it picks up where it left off.');
end;
