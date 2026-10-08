# Magic links & navigation (#374)

FLUJO's app-shell state (which flow/conversation/server is open) is reflected
in the URL as query params on the existing pages — there are no new route
segments. Every "copy link" affordance and every deep-link consumer shares
one builder, `src/frontend/utils/magicLink.ts`, so the scheme below is
authoritative.

## URL scheme

| Entity | Magic link | Behaviour on open |
|---|---|---|
| Flow (view in dashboard) | `/flows?flow=<id>` | select the flow |
| Flow (open editor) | `/flows?flow=<id>&mode=edit` | open the FlowBuilder directly |
| Conversation | `/chat?conversation=<id>` | select that conversation |
| Message | `/chat?conversation=<id>&message=<msgId>` | select conversation, scroll to + highlight message |
| New chat bound to a flow | `/chat?flow=<id>` | create a new conversation for that flow (one-shot) |
| Model | `/models?edit=<id>` | open the edit modal |
| MCP server | `/mcp?server=<id>` | open that server's details modal |

Rules:

- Unknown/invalid ids are **ignored silently** after a `log.warn` — never
  thrown, never leaked. Ids only; magic links must never carry secrets,
  tokens, or key material.
- Params that represent *durable* state (`flow`, `mode`, `conversation`,
  `server`) stay in the URL so Back/Forward and refresh keep working.
- Params that represent a *one-shot action* (`?flow=<id>` on `/chat`, the
  `?server=<id>&tool=<name>` tool-tester deep link) are consumed and cleared
  with `router.replace()` once handled.

## Building blocks

- `src/frontend/utils/magicLink.ts` — pure `magicLinkPath()` / `magicLinkUrl()`
  builders. Always `encodeURIComponent`s ids via `URLSearchParams`.
- `src/frontend/hooks/useEntityDeepLink.ts` — the shared "read a param once,
  validate it, resolve it, optionally clear it" hook. Replaces the three
  previously copy-pasted `useRef(false)` deep-link effects.
- `src/frontend/hooks/useHistoryGuard.ts` — makes browser Back/Forward respect
  the existing `NavigationGuard` (Save/Discard dialog), which previously only
  intercepted top-nav clicks.
- `src/frontend/components/shared/CopyLinkButton.tsx` — a small "copy a
  shareable link to this entity" `IconButton`, with a `document.execCommand`
  fallback for non-secure origins where the Clipboard API is unavailable (also
  exports the underlying `copyText()` helper for call sites, like the
  per-message "Copy link" menu item, that need a `MenuItem`/non-`IconButton`
  affordance instead). Present on flows, MCP servers, conversations
  (`ChatHistory.tsx`), models (`ModelCard.tsx`), and messages (the per-message
  menu in `ChatMessages.tsx`).

## Back means Back in the FlowBuilder

The FlowBuilder is entered via `router.push('/flows?flow=<id>&mode=edit')`
(a real history entry) instead of flipping local state, and `isEditing` is
*derived* from `searchParams.get('mode') === 'edit'` rather than tracked as
its own `useState`. Pressing Back:

1. Fires a `popstate`.
2. `useHistoryGuard` immediately re-pushes the guarded URL (cancelling the
   pop) and offers a `router.back()` navigate callback to the app's existing
   `NavigationGuard`.
3. If nothing is registered (or the guard approves — e.g. the user confirms
   "Discard"), the callback runs `router.back()` for real; that call's own
   popstate is pre-suppressed so approval never re-triggers the guard.
4. If the editor has nothing to pop back to (e.g. a fresh deep link landed
   directly in edit mode), `handleBackToDashboard` falls back to
   `router.replace('/flows')` instead of `router.back()`, so Back can never
   leave the app entirely.

## Back means Back for the MCP server & model-editor modals

Opening the MCP server details modal (`handleOpenDetails` in
`MCPServerManager/index.tsx`) and the model edit/add modal (`ModelClient.tsx`)
both `router.push()` their `?server=<id>` / `?edit=<id>` / `?add=<...>` URL, so
opening is a real history entry, not just local `useState`. Each tracks
whether *it* pushed the current entry (`detailsPushedByUsRef` /
`modalPushedByUsRef`) so closing prefers `router.back()` (popping that same
entry) and only falls back to `router.replace()`/`router.push('/models')` when
the modal was opened from a deep link with nothing safe to pop back to. The
MCP server modal additionally listens for `popstate` while open so pressing
Back (not just the in-modal close button) clears the local `detailsServerName`
state in step with the URL. `ModelClient.tsx`'s `isModalOpen`/`currentModel`
are still derived directly from `searchParams.get('edit'|'add')` on every
render (like `isEditing` in `/flows`) rather than resolved once via
`useEntityDeepLink` — that hook is for one-shot/durable *resolution into a
separate state*, and this modal's open/closed-ness already has the URL as its
single source of truth, so migrating it would add a redundant copy of state
rather than remove one.

## Known follow-ups (out of scope for this pass)

- `/waves` and `/executions` have no URL state at all. Low priority per the
  issue — neither page has a single "open thing" that a link obviously points
  to the way a flow/conversation/model/server does.
- The MCP Apps dashboard's "open tool tester" shortcut
  (`onOpenToolTester` in `MCPServerManager/index.tsx`) still opens the details
  modal via local `useState` only, without pushing a history entry — a much
  narrower path than the main server-card click handler covered above.
