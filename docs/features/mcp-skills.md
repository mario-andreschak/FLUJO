# MCP Skills (experimental)

FLUJO implements the draft MCP Skills extension identified by
`io.modelcontextprotocol/skills`. The wire adapter is frozen to SEP-2640 pull
request head `a3e147ca2710f68214247aecc729731ee1ae8d03` (updated 2026-08-29).
Because the SEP remains a draft, a future revision may require a compatibility
update.

## Enabling Skills

Skills are disabled by default for every MCP server. Enable **MCP Skills** on an
individual server card. FLUJO then reconnects that server, inspects its
server-side extension capability, and calls `skills/list` or `skills/get`
only when both the local opt-in and the advertised extension are present.
FLUJO does not advertise a client-side Skills extension.

The server details dialog has a Skills tab. Discovery does not load or activate
anything. **Load for this conversation** is a separate user action: the host
records a workspace- and conversation-scoped approval for the exact server,
normalized URI, and current manifest digest before verifying the content. The
loaded bytes remain in browser session memory. Chat then presents those loaded
Skills in a per-turn picker whose default is no selection.

## Validation and trust

A successful listing is still untrusted remote data. FLUJO validates:

- the hierarchical resource URI and top-level `SKILL.md` entry point;
- Agent Skills `name` and `description` constraints;
- complete resource declarations, uniqueness, and containment;
- lowercase `sha256:<64 hex>` digests and non-negative byte sizes;
- at most 512 resources and 16 MiB of declared content per Skill;
- the bytes, declared size, and SHA-256 digest of every resource it loads.

`resources/directory/read` is used only when the downstream extension
advertises `directoryRead: true`. Dynamic Skills have no stable digest and are
discoverable but cannot pass the verified loading boundary.

Identity is always server-qualified. A URI advertised by server A is distinct
from the same URI advertised by server B. The standalone `mcp-flujo` server
rewrites downstream identities to `skill+flujo://` URIs so this distinction is
preserved on its aggregated surface.

Verification is not approval. Reading a generic resource, including
`SKILL.md`, never approves or activates a Skill. Approvals expire with the host
session and are scoped to one workspace and conversation. A changed manifest
digest invalidates both approval and the UI's session-memory selection and
requires another explicit load. When a user selects a loaded Skill for a turn,
FLUJO reloads and verifies it server-side, then inserts a bounded, clearly
marked untrusted data message into that turn's model wire context. It is never
copied into durable chat history or trusted Persona instructions.

## Proxy and standalone behavior

An exposed per-server proxy advertises Skills only when all existing proxy
gates pass, Skills are enabled for that server, and the downstream capability
is present. The proxy remains localhost-only, encryption-lock gated, and
stateless; it forwards discovery and optional directory reads but owns no
approval state.

The standalone `mcp-flujo` process implements the same frozen draft revision. Its
localhost control route aggregates enabled downstream catalogs with bounded
pagination, validates the final catalog with the host schema, and rewrites
server-qualified URIs. The standalone client also validates list/get responses
against package-local copies of the same URI, digest, containment, duplicate,
and size rules. Reads of rewritten Skill resources pass through FLUJO's
size/digest verifier.

## Explicit exclusions

Remote Skill content cannot:

- install packages, repositories, archives, or MCP servers;
- expand tool, filesystem, root, or network authority;
- activate itself or persist approval across conversations;
- enter trusted Persona instructions automatically;
- expose secrets or bypass the existing disabled-server, lock, workspace,
  proxy-exposure, or same-server boundaries.

When the SEP changes, update the revision constant, schemas, validators, proxy,
standalone adapter, documentation, and compatibility tests together.
