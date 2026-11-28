# The page audio hook is shared: the live view and a recording each switch only their own listener, so one never silences or takes the other's sound

Both used to install the same in-page hook with one on/off switch and one
callback. Whichever installed first received all the sound, and the live
view's install switched off the audio of a recording already running. This
mattered as soon as a page opened with `browser_open` (which already has the
live view's hook) could be recorded.

Enforced by:
- `__tests__/mcp/browserAudioTapListeners.test.ts`
- `__tests__/mcp/browserCaptureRecording.test.ts` (real browser)
- `audioSinkMutedExpression` in `mcp-servers/browser/src/audioTap.ts`
