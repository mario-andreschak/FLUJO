# The container image is built and passes the container smoke (Node, health, first chat, voice check, hard stop) on every main-target change and before release

A container change used to wait for someone to build the image and try it on a
cloud machine with a real Claude token (#1408). The smoke does that with local
stand-ins on 1 CPU and 2 GB, so the check never needs a person or an account.

Enforced by:
- `assertContainerSmoke` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`
- `scripts/smoke-container-image.test.mjs`
- `scripts/container-smoke/stand-ins.test.mjs`
