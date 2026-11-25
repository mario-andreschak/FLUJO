# Anthropic Messages requests never send `temperature`, `top_p` or `top_k` (API version 2026-10-21 refuses them on every model); a saved Creativity is kept but not sent. An SDK major that moves to another API version fails until its rules are reviewed

Enforced by:
- `__tests__/model/anthropicApiVersion20261021.test.ts` (installed SDK, stand-in server with that version's request rules)
