# Named access: people, roles and who did what

An ordinary FLUJO install has one user and no sign-in, and it stays that way. Named
access is for an installation that several people use, or that another product calls
on behalf of its staff. It is off until you turn it on.

## What you get

- **Roles.** Each person has their own secret and a role.
- **Separation.** A person sees only the conversations, runs and approvals they
  started, unless their role says otherwise.
- **End-user references.** A product that calls FLUJO with one credential can say
  which of its own users a run is for.
- **A record of who did what**, with no message content in it.
- **Settings > People and access** to manage all of this. Nobody has to edit a file.

## Roles

| Role | Can do | Sees |
| --- | --- | --- |
| Administrator | Everything, including secrets, MCP setup and managing people | Everything |
| Builder | Edit and test flows, run flows, answer approvals | Own runs |
| Operator | Run flows, answer approvals | Own runs |
| Viewer | Read flows and runs. Changes nothing | Every run |
| Health only | Read health status | No conversation content |
| Maintainer | Read health status, start an update | No conversation content |

A role is a name for a list of exact permissions. If none fits, choose **custom** and
give the list yourself. [The security guide](../security/named-access-v1.md) lists them.

## Turning it on

**On an install with no sign-in yet**, run this on the computer FLUJO runs on:

```text
node scripts/owner-access.mjs enable <new-private-folder> --origin http://localhost:4200
```

The folder must be new and outside the data folder. The command writes the first
administrator's secret into a private file in that folder and prints two settings.
Add those settings to how you start FLUJO, restart it, open `/owner/login` and sign in
with the secret. Then delete the secret file. On Windows, restrict the folder to the
account that runs FLUJO.

**On an install that already has an owner policy**, open Settings > People and access
and choose **Turn on named access**. Existing secrets keep working and your browser
session stays open.

## Adding a person

In Settings > People and access, enter a name, choose a role and how long the access
lasts. FLUJO shows the secret once. It keeps only a fingerprint of it and cannot show
it again. If a secret is lost, revoke it and create a new one.

From there you can rename someone, let their access expire now, or revoke it.
Revoking takes effect on the very next request and also ends streams already open.

FLUJO refuses to remove the last administrator, so nobody can lock themselves out by
accident.

## Limiting someone to one workspace or to named flows

- **Workspace.** A credential limited to a workspace cannot select any other. This
  is how you serve several sites from one instance: give each site its own workspace
  and credentials limited to it. Someone with permission to manage people who is
  limited to a workspace can only manage people there, and cannot hand out more than
  they hold.
- **Flows.** A credential can be limited to named flows, for running them and reading
  its own runs. It sees those flows in `/v1/models`, and cannot start any other flow
  or call a model directly.

Flows called from an allowed flow still run. Whoever built the flow chose them, and
stopping them halfway would break the flow. The person cannot start those flows
directly, and the child runs belong to them like the rest of their run.

Be careful with what these limits mean: **workspaces separate access, not processes.**
[The security guide](../security/named-access-v1.md) explains what they do not protect
against.

## Calling FLUJO from your own product

Give your product one credential with the **Operator** role and pass your own
reference for the person, in either of these ways:

```http
POST /v1/chat/completions
Authorization: Bearer flo_v1_...

{ "model": "flow-Orders", "messages": [...], "user": "staff-17" }
```

```http
POST /api/approvals/<id>
Authorization: Bearer flo_v1_...
X-Flujo-End-User: staff-17
```

A reference is up to 128 characters of letters, digits and `. _ : @ + -`, and must
start with a letter or digit. Anything else is refused. Use an opaque id rather than
a name or an email address, since it is stored and appears in the record.

FLUJO records the reference and you can filter by it, for example
`GET /v1/chat/conversations?endUser=staff-17`.

**A reference is a label, not a boundary.** FLUJO trusts what your product says, and
two staff members behind one credential can see each other's runs through it. Your
product has to keep them apart. If they need to be apart inside FLUJO, give each their
own credential.

## Who decided an approval

Every approval answer records who gave it, including the end-user reference if there
was one. It is stored on the conversation (`approvalDecisions`) and in the record.

## The record of who did what

Settings > People and access shows sign-ins, changes to people, flow changes,
approval decisions and refused attempts to reach someone else's conversation. It holds
ids, names and outcomes, and never a secret, a message, a prompt or a tool argument.

It lives next to the policy file, not in a workspace, so it does not leave with a
workspace export. It is limited to about 10 MB in two files and the oldest entries
drop off. Change the limit with `FLUJO_ACCESS_AUDIT_MAX_BYTES` (per file, default 5 MB).

## If something goes wrong

Control of this computer's files is what gets you back in. There is no remote reset.

| Situation | What to do |
| --- | --- |
| All administrators are lost or expired | `node scripts/owner-access.mjs recover <policy-file>` adds a new administrator and leaves everyone else alone |
| The policy file is damaged | The same command. It keeps the damaged file aside and starts a new one; people are lost and need new secrets |
| A change went wrong | `node scripts/owner-access.mjs restore <policy-file>` puts back the last good version |
| Going back to an older FLUJO | `node scripts/owner-access.mjs export-v1 <policy-file> <new-file>` writes a file the older version can read. Point `FLUJO_OWNER_AUTH_FILE` at it. People with narrow roles are left out rather than widened |

The new secret goes into a private file named in the output, never on the screen.
While the policy is damaged FLUJO refuses access rather than opening up, and its
startup message names the recovery command.
