# Several people on one FLUJO

FLUJO can let several people use one installation, each with their own private
workspaces. It is off until an admin turns it on. While it is off, nothing
changes: there is no sign-in page and no new file.

Design and rules: [multi-user plan](../architecture/multi-user-plan.md) and
[multi-user contracts](../architecture/multi-user-contracts.md).

## Turn it on

In FLUJO: **Settings → Users and sign-in**. Pick your sign-in name and a
password of at least 15 characters (a few ordinary words in a row work well),
then choose "Turn on sign-in for several people". You become the first admin,
every existing workspace becomes yours, and this browser stays signed in.

On the server instead:

```sh
node bin/flujo.mjs users init anna          # npm package (data in ~/.flujo)
npm run users -- init anna                  # git checkout (data next to the app)
```

The command asks for the password twice. In scripts, pipe it in with
`--password-stdin`. Passwords never go on the command line.

If an owner sign-in policy (`FLUJO_OWNER_AUTH_FILE`) was set up, its API tokens
are copied to the first admin, so scripts and MCP clients keep working.

## What people see

- Everyone signs in at `/owner/login` with their name and password. A session
  lasts 8 hours.
- A person sees only the workspaces they own. Someone else's workspace answers
  exactly like a workspace that does not exist.
- A person who owns no workspace yet gets one named after them at their first
  sign-in.
- Admins see every workspace, including "unassigned" ones (created while
  sign-in was off), and can give a workspace to a person.
- Wrong passwords slow that name down: 1 second, then twice as long each time,
  at most 15 minutes. It clears after a successful sign-in, a quiet spell or a
  restart. There is never a permanent lockout.

## Host access

Some things run programs on the server computer: local (stdio) MCP servers
outside the container, Claude Code, Codex and Antigravity as models, installing
from GitHub, the system screenshot, browsing server folders, git and updates.
Anyone who can do that can read every person's files. So only admins can, plus
people an admin trusted with **host access** in Settings. Everyone else uses MCP
servers in the isolated container profile or remote MCP servers.

## Scheduled work

Schedules, triggers and personas act for the workspace owner. When an admin
turns an owner off, their automatic runs pause. They run again by themselves
once the owner is turned on again, also after a restart.

## Manage people on the server

```sh
node bin/flujo.mjs users list
node bin/flujo.mjs users add ben [--admin] [--host-access] [--display-name "Ben"]
node bin/flujo.mjs users disable ben          # signs ben out everywhere
node bin/flujo.mjs users enable ben
node bin/flujo.mjs users reset-password anna  # a forgotten admin password
node bin/flujo.mjs users assign team-notes ben
node bin/flujo.mjs users off                  # back to a single-user FLUJO
node bin/flujo.mjs users on                   # on again with the same people
```

Use `--data <folder>` when FLUJO keeps its data somewhere else. The running
server notices every change at the next request; no restart is needed.

## Turn it off

**Settings → Users and sign-in → Turn off sign-in for several people**, or
`users off` on the server. Nothing is moved or deleted and everyone is signed
out. FLUJO is a single-user installation again; the people and owners stay in
`<data>/accounts/accounts.json` for the next time.

If `accounts.json` gets damaged, FLUJO uses its last good copy
(`accounts.json.bak`). If both are damaged, sign-in stops with a plain message;
`users off` on the server moves the damaged file aside and makes FLUJO usable
again.

## Limits

- Multi-user mode keeps people apart inside FLUJO. It does not protect anyone
  from an admin, from people with host access, or from anyone who can log in
  to the server machine.
- It is meant for one machine or a local network of colleagues. It is not made
  for public hosting for strangers.
- The remote voice device (`FLUJO_AVATAR_REMOTE_ORIGIN`) still signs in with
  the owner policy and does not work while multi-user mode is on.
