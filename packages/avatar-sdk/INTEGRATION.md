# FLUJO integration

FLUJO imports the exact SDK package extracted from the committed archive. The
local directory dependency follows the existing Antigravity CLI packaging pattern
and lets npm extract the parent package before resolving SDK files. Docker stages
and the FLUJO npm package both include the complete directory.

`node scripts/verify-avatar-sdk.mjs` verifies the original archive's pinned SHA-512
and the 37 runtime/declaration/worklet hashes from clean Avatar revision
35c9b79613d0ad456a9c44e1efcc78205ecde122. No SDK code is rebuilt here.

World rendering, Eyes and native voice resolve through the SDK. FLUJO retains
workspace selection, saved conversations, authorization, receipts, API routes,
execution and worklet serving. Optional voice providers remain host controlled.
