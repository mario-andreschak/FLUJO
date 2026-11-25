# A browser recording runs as long as asked, or is refused with a reason; it is never shortened silently. Its limit follows free disk space, it stops early only when the disk really runs low, and stopping keeps the page open

Enforced by:
- `__tests__/mcp/browserRecordingDuration.test.ts`
- `__tests__/mcp/browserCaptureRecording.test.ts` (real browser)
