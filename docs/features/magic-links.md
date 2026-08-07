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
  fallback for non-secure origins where the Clipboard API is unavailable.

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

## Known follow-ups (out of scope for this pass)

- `ModelClient.tsx`'s `?edit=`/`?add=` handling was left on its existing
  `prev ?? {...}` pattern rather than migrated onto `useEntityDeepLink` —
  it's a continuously-derived modal state rather than a one-shot resolve, and
  migrating it safely needs more room than this pass allowed.
- Message-level anchors/highlight (`?message=<id>`) and a conversation-level
  `CopyLinkButton` in `ChatHistory.tsx` are not yet wired.
- `/waves` and `/executions` were not touched.
