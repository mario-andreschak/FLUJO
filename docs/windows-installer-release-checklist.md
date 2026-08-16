# Windows installer release checklist

Use this checklist for every release that publishes `flujo-setup.exe`. Record the
Windows edition/build, tester, date, artifact SHA-256, and results in the release
verification notes. Do not promote the installer until every required item passes.

## Release inputs

- [ ] Confirm `package.json` contains the intended npm version and the npm package
      has been built and published through the normal release process.
- [ ] Confirm the release tag is exactly `v<package-version>` and points to the
      reviewed commit.
- [ ] Decide whether this release needs a non-`main` installer channel. The Inno
      source supports `MyBranch`, but CI intentionally builds the normal `main`
      channel unless the workflow is explicitly changed and reviewed.
- [ ] Record the current code-signing decision. The installer is currently
      unsigned; adding signing requires maintainer approval, repository-managed
      certificate secrets, and a documented certificate-rotation procedure.
- [ ] Keep `Uninstallable=no` unless maintainers explicitly approve a discoverable
      Windows Apps entry. The supported uninstall path is `scripts/uninstall.ps1`.

## Automated validation

- [ ] The `Validate Windows installer` workflow passed its independent Pester job.
- [ ] Tests did not call winget, Git/npm, execution-policy setters, or destructive
      filesystem operations; they only loaded `scripts/installer-functions.ps1`.
- [ ] CI installed the pinned Inno Setup version and successfully compiled
      `installer/flujo-setup.iss`.
- [ ] CI retained one non-empty `flujo-setup.exe` validation artifact.
- [ ] The version-tag run attached exactly one `flujo-setup.exe` asset to the
      matching GitHub Release; a pull request or `main` run did not modify releases.
- [ ] Download the release asset, verify that its SHA-256 matches the recorded
      value, and confirm Windows can start it.

## Clean-Windows smoke-test matrix

Run these scenarios against the downloaded release asset on a supported clean
Windows VM. Restore a snapshot between scenarios when prerequisite state matters.

| Scenario | Required verification | Result / evidence |
| --- | --- | --- |
| No Git, Node.js, Python, uv, or ripgrep | Wizard detects the missing tools, installs them through winget, builds FLUJO, and leaves a working `flujo` command and manifest. | |
| All prerequisites preinstalled | Installer keeps them, records `preexisting: true`, and a later uninstall defaults to keeping them. | |
| Mixed prerequisite state | Only missing prerequisites are installed; manifest ownership matches the before/after state. | |
| Missing winget/App Installer | Wizard and PowerShell entry point stop with actionable App Installer guidance and leave no launcher, shortcut, or partial registration. | |
| Restrictive PowerShell policy | Consent text is clear; accepting enables future npm/npx use, declining still completes the current session, and the manifest records only an actual persistent change. | |
| Default wizard choices | Installs under `%LOCALAPPDATA%\FLUJO`, creates the selected shortcut, and can launch at `http://localhost:4200`. | |
| Custom path and no shortcut | Installs into the selected path, launcher uses that exact path, and no desktop shortcut is created. | |
| Optional Ollama | Declining causes no Ollama change; accepting installs/records it and uninstall follows the same ownership default as other prerequisites. | |
| Existing-install rerun | A second run updates the existing Git checkout without duplicating PATH or shortcut entries and preserves user data. | |
| Existing non-Git target | Installer rejects the target before package, clone, launcher, or manifest mutations. | |
| `scripts/update.ps1` | Stops FLUJO, updates/builds the checkout, and restarts successfully. | |
| Uninstall, keep optional tools | `DELETE` confirmation is required; FLUJO files, launcher, PATH entry, shortcut, and metadata are removed while declined prerequisites remain. | |
| Uninstall, remove FLUJO-owned tools | Only explicitly selected tools are passed to winget/npm removal; preexisting tools default to keep. | |
| Cancel uninstall | Any response other than uppercase `DELETE` makes no changes. | |

## Release notes and rollback

- [ ] Add the tested Windows build, smoke-test outcomes, known warnings, artifact
      SHA-256, signing state, and reviewer to the release verification notes.
- [ ] Confirm the README installer, rerun/update, prerequisite, and uninstall
      guidance matches the released behavior.
- [ ] If validation fails after tagging, remove the bad installer asset or mark the
      release as a prerelease, fix on `main`, create a new version tag, and repeat
      the complete checklist. Do not silently replace an already-verified binary.
