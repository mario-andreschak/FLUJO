# Several people on one FLUJO

FLUJO can let several people use one installation, each with their own private
workspaces. It is off until an admin turns it on. While it is off, nothing
changes: there is no sign-in page and no new file.

Design and rules: [multi-user plan](../architecture/multi-user-plan.md) and
[multi-user contracts](../architecture/multi-user-contracts.md).

## Turn it on

In FLUJO: **Settings → Users and sign-in**. Keep the suggested sign-in name
"owner" or pick your own, choose a password of at least 15 characters (a few
ordinary words in a row work well), then choose "Turn on sign-in". You become
the first admin, every existing workspace becomes yours, and this browser stays
signed in. This is also the way to protect a FLUJO that only you use: no
environment variables or command-line tools are needed.

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

## Teams

A team shares whole workspaces. Admins make teams in **Settings → Users and
sign-in → Teams**; the admin and the team's owners then add people.

| Role in the team | Can do in the team's workspaces |
|---|---|
| Owner | Everything, also manage the team, show stored keys, back up and restore |
| Member | Look at, change and run flows, models, MCP servers, chats and runs; keys stay hidden (`********`) but work in runs |
| Viewer | Only look; cannot change or run anything |

- **Add or invite.** "Add now" puts the person in at once; "Invite" lets them
  accept or decline first in their own Settings.
- **Team workspaces.** A team owner (or admin) makes one with "New team
  workspace". An admin can also give an existing workspace to a team.
- **Remove someone.** They lose access at their next click, and open live views
  close within a second.
- **Two people editing.** When someone else has the same flow, model or MCP
  server open, the editor says so ("Anna is editing this too"). If they save
  first, your save is not lost and does not overwrite theirs silently: FLUJO
  explains what happened and offers to load their version, compare the two, or
  save yours over theirs.
- **Change history.** Every change to a flow, model or MCP server in a team
  workspace is recorded with who made it and when, and any older version can be
  restored. Keys and passwords are never kept in the history; a restore keeps
  today's keys. Each item keeps its newest 200 changes; older ones go by
  themselves.
- **Copy into a team.** "Copy to a team workspace" on a flow, model or MCP
  server copies it without keys, tokens, passwords or private folders. The copy
  lists what the team still has to enter (for example its own API key) and the
  models or servers it uses that the team workspace does not have yet. A copied
  MCP server starts turned off.

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

A schedule or trigger also remembers who set it up (the last person who created
or changed it). Its automatic runs pause while that person may not run things
in the workspace any more (removed from the team, made a viewer, turned off)
and run again by themselves once they may, or after someone who may changes it.
A team workspace keeps running while at least one owner or member is active.

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
- A team viewer cannot use pages that change something when they open. Only
  flows, models and MCP servers have the "someone else saved first" check and
  the change history; other things in a team workspace (chats, schedules,
  personas) save as before.
- The version check for models and MCP servers starts when you open their
  editor, not when the list was loaded.
