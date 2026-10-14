# Meeting transcript migration to react-window 2

Existing PR #1133 proposed react-window 2.3.4, which removes the v1 `VariableSizeList` API used by `MeetingTranscript`. This batch migrates that existing component to `List`, its bundled row/ref types and `scrollToRow`, and removes the obsolete `@types/react-window` dependency. The base is main `84380419a06c8d71c3c8731f54d7a771b951d9fb`; the original PR head is `c2f809fe42d80dcd6523c51473a90a8db7072851`.

Measured heights now update React state, so the v2 list recalculates its bounds after media loading and speaker collapse. Measurements are keyed by event/round ID and tagged with the measured container width. A separate width observer invalidates hidden desktop measurements and remeasures visible rows on resize. Memoized row keys preserve surviving row identity during filtering; list-item ARIA and a named list remain available to assistive technology. Live mode follows newly measured/appended rows; Paused preserves the reader's position.

Built acceptance also reproduced a concrete existing overflow: the hidden live announcement's MUI `width: 1` became 100%, extending a 1440px desktop document to 1481px. Explicit one-pixel width/height fixes this without removing the polite live announcement.

## Qualification

- Full local typecheck passed in 17.249s; full source lint passed in 101.412s. The phases overlapped. Targeted new-test and browser-harness lint passed.
- Two focused suites passed all 15 cases (6.371s): eight new cases render the real v2 List, plus seven existing transcript projection cases. They cover round headers, speaker/error/motion filters, no-match and waiting states, media growth/shrink, surviving keys, speaker collapse, hidden width invalidation and Live/Paused scrolling.
- The inspected non-container application/five-MCP build passed in 310.645s after the overflow fix. Runtime: v22.23.3. Build ID: `7huEdsasKCA0JQZUlAF6e`.
- The committed browser harness passed against that actual production build using installed Edge 155.0.4283.45 and an isolated profile issued through the production owner credential issuer. Measured browser phase including startup/stop: 14.221s.
- Both desktop 1440x1000 and phone 390x844 exercised delayed image loading, aligned row geometry, stable filtering, errors/motions/no-match recovery, native Enter collapse/expand, narrower viewport resizing, waiting state and real persisted private-note POSTs. Paused kept scrollTop=0 after a save; Live followed newly saved notes.
- Document width equaled viewport width: desktop 1440/1440 and phone 390/390. Responsive row measurements matched actual content: 331/331px at 390px resize, and 309/308.5px at 360px resize.
- Browser errors, external requests and provider requests were zero. The owned app stopped with exit143. Its fixture/operator directories are explicit owned cleanup targets for the final flujo-bash receipt.

The fixture begins with persisted meeting events; new notes go through the actual authenticated meeting API and UI. This is focused development qualification. Hosted-model, broader/full suites, installed distribution, remote CI and container/release qualification remain separate. CI definitions and existing security/assertion gates are unchanged; no workflow was dispatched.

## Bound inputs

SHA-256 of the exact working input bytes shared by the final build and browser check:

| Input | SHA-256 |
| --- | --- |
| src/frontend/components/Meetings/MeetingTranscript.tsx | 545baba7664fe632e55e3aee8fee548f52890db68c610a283540a7df4854dfaa |
| __tests__/frontend/components/MeetingTranscriptVirtualization.test.tsx | a9b552aa95647062b4347611451189ca5f9f1fc80d65a22ebcad268bb3155eee |
| package-lock.json | 78e63baa20d5fd4f9d87001ac4524592a14d55390b6ebfc3254b9f642484bb85 |
| package.json | 16af29b86d53f73cecfe01db226399e9ec668a99cd9a6c2382fcc2f022c880a2 |
| scripts/meeting-transcript-browser-acceptance.mjs | 3c69113c65a9398634443445c4784ec3ad8b69e9afc92154a2f623cc8d558cd4 |

The published candidate and actual protected main result must share this qualified Git tree. Evidence receipts and screenshots are held in the automation's current handover; that handover owns cleanup and the next existing backlog.

[Upstream v2 API and bundled types](https://github.com/bvaughn/react-window/blob/2.3.4/README.md) document the imported APIs. Next.js 16.4's installed Client Component guide was read before implementation.
