# The type check and the development server get a heap that follows the machine

Both need about 4 GB. Node.js allows itself only 2 GB on a computer with less
than 16 GB of memory, so on an 8 GB laptop (and the 7 GB macOS CI machines)
`npm run typecheck` and the first `dev` start ran out of memory (#1441). Give
such a tool `scaledHeapMegabytes` or `withScaledHeap` from `bin/node-heap.mjs`
instead of a fixed `--max-old-space-size`; a heap set in NODE_OPTIONS still wins.

Enforced by:
- `scripts/node-heap.test.mjs` (in `npm run test:checks`)

Verified by:
- `node scripts/contributor-guide.mjs` (the contributor-guide job of `.github/workflows/verify-full.yml` runs both on a 7 GB macOS machine)
