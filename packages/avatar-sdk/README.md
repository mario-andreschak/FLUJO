# Flujo Avatar SDK

`@flujo-ai/avatar-sdk` provides Eyes, FactoryAvatar, WorldScene, WorldSky and
`useNativeRouterVoice`, with their TypeScript contracts. It bundles the existing
presentation and voice implementations. The host retains authentication,
workspace validation, saved conversations, tools and execution.

```tsx
import { Eyes, WorldScene, useNativeRouterVoice } from '@flujo-ai/avatar-sdk';
import '@flujo-ai/avatar-sdk/styles.css';
import '@flujo-ai/avatar-sdk/world.css';
```

Pass a host-validated `AvatarWorldSnapshot` to WorldScene. Supply a
`NativeVoiceTransport` with a public `scopeKey`, host-served `workletUrl` and an
authenticated request callback to the voice hook. Changing scope revokes old
audio. The default uses the existing same-origin `/api/avatar/*` routes and
`/avatar-audio-capture.js`; the SDK does not provide a backend. Serve the packed
`public/avatar-audio-capture.js` at that path or supply the existing host worklet.
Begin audio only on user demand.

Native Flujo result receipts and accepted O task UUIDs have different contracts.
`createAcceptedTaskNarrationTransport` remains disabled without a qualified host
binding; it does not replace native Flujo result narration. Local Pocket speech
is a separate host-owned output provider and can coexist with this SDK.

Run `npm run build` from the repository root, then
`npm run pack:sdk -- --pack-destination <directory>`. Install the exact archive
with a lockfile. PROVENANCE.json records the source commit, whether tracked
source was dirty, and member hashes. NOTICE.md retains canonical World
attribution. No registry publication is required. Older Avatar and World
identities remain available for consumers with existing pins.
