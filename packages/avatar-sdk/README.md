# Avatar SDK integration

FLUJO World consumes the committed `@flujo-ai/avatar-sdk@0.1.0` archive from
flujo-avatar source `35c9b79613d0ad456a9c44e1efcc78205ecde122`.
The lockfile pins archive integrity. Run `node scripts/verify-avatar-sdk.mjs`
to verify that archive and all 37 recorded runtime/declaration/worklet members.

WorldScene is byte-identical at its canonical source boundary to the renderer
previously stored here. Its local wrapper now imports the package and explicit
World CSS. Eyes and the native voice hook also resolve through the SDK. Host
workspaces, saved conversations, receipts, authorization, API routes, panels,
worklet serving and execution retain their existing owners. Server-side adapter
sources remain available for the existing FLUJO backend.

The SDK contains optional Pocket output and OpenRouter native voice adapters;
installing it activates neither provider. Existing O phone bindings continue to
supply the same transport callback. Live microphone and deployment acceptance
remain separate from source checks.
