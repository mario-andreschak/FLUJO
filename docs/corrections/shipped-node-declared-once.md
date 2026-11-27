# The installers and the container image ship the Node version declared in `shipped` of `scripts/ci-node-binaries.json`; an image on another Node line says why

Enforced by:
- `scripts/verify-ci-node.test.mjs`
- `shippedNodeRuntimes` in `scripts/verify-ci-node.mjs`
