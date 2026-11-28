# A conversation save's fences, quarantined slots, intent files and writer locks heal when their owner settles or its process is gone; no chat stays blocked

This includes an intent file that a full disk left without its owner record:
the process that made it remembers it and reclaims it on the next save.

Enforced by:
- `npm run check:formal` (`docs/formal/`)
- `__tests__/flow/conversationPublication.property.test.ts`
- `__tests__/flow/conversationPublicationDurability.test.ts`

Verified by:
- `scripts/packaged-acceptance.mjs` (the disk-full check on every shipped form)
