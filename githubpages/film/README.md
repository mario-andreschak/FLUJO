# One idea. A little help.

A new, silent, exactly **60-second HTML5 film** for the coffee-workshop journey.
The existing `../short/` film and studio are unchanged. The new page has no runtime
dependencies, narration calls, audio tracks, analytics, or external font requests.

## Watch and inspect

Serve `githubpages/` as a static directory, then open `/film/`.

- Play/pause, replay, seek, fullscreen, and a gentle-motion toggle are available.
- The film waits for a click to play and pauses when its tab becomes hidden.
- With the player focused: Space/K toggles playback, arrows seek five seconds,
  Home/End selects either end, and F toggles fullscreen. Native controls keep
  their own keyboard behavior.
- `?t=33` opens a paused, deterministic preview. Values are clamped to 0–60.
- `?render=1&t=33` shows only the canvas for screenshots and export.
- Narrow viewports use a separately composed portrait layout.
- Reduced-motion preferences suppress animated entrance movement; the complete
  story is also available as a semantic, seekable text transcript.

## Timeline

| Time | Scene |
| --- | --- |
| 0–5 | An idea: a small coffee workshop |
| 5–11 | Install and connect a useful web-reading tool |
| 11–18 | Ask with a public source |
| 18–23 | A practical checklist |
| 23–29 | Maya, Day 1: goal and context |
| 29–36 | Day 2: continue the plan and invitation draft |
| 36–43 | Day 3: shopping list, run sheet, review |
| 43–49 | The workshop materials together |
| 49–54 | Connect a tool. Make a helper. Keep going. |
| 54–60 | Get started |

Day 1–3 are **compressed demonstration sessions**, not elapsed days or proof of
unattended reliability. Illustrative cards are labeled. Only verified framebuffer
captures may be configured in `captures.js`; never create imitation application
screens. The capture lane's runtime is the published FLUJO 3.46.2 release, while
the surrounding source checkout is 3.46.3.

This is an agent-operated live software demonstration with operator-reviewed
outputs, not an independent human usability study. The operator reviewed memories,
resumed the goal, saved final approval, and reconciled shopping quantities. The
controller marked the goal complete after four work sessions within the three
compressed sessions. Some older status wording remained stale. Read the complete
[workshop pack](../../docs/journeys/evidence/workshop-pack.md) and
[capture provenance](../../docs/journeys/evidence/capture-provenance.md) for those
limits and the original evidence. The film does not claim a correct first answer:
its checklist capture is the corrected reply after a complete source read.

The connection scene summarizes a setup process, not a one-click installation.
In the recorded 3.46.2 flow, `fetch-mcp` requires correcting the detected install
command to `npm install --include=dev`, followed by a separate build with Bun
available. The complete guide carries those steps.

## Verify and export

The tooling reuses an existing Playwright installation; it installs nothing.
Set `PLAYWRIGHT_MODULE` to its module path if it cannot be resolved locally.

```powershell
node githubpages/film/tools/verify.mjs
node githubpages/film/tools/render.mjs githubpages/film/flujo-coffee-60s.mp4
ffprobe -v error -show_entries format=duration:stream=codec_type,nb_frames,r_frame_rate -of json githubpages/film/flujo-coffee-60s.mp4
```

The exporter samples the HTML5 canvas at `frame / 30` for frames 0–1799, streams
JPEG frames directly to FFmpeg, and produces 1,800 H.264 frames at 30 fps with no
audio. No temporary frame directory or intermediate video is created. Both the
browser and temporary HTTP server close in `finally` blocks.

For a poster or a specific frame:

```powershell
node githubpages/film/tools/render.mjs githubpages/film/poster.png --poster
node githubpages/film/tools/render.mjs C:/path/to/phone-frame.png --poster --portrait --t=33
```

All cleanup and deletion must go through flujo-bash MCP, including any optional
QA screenshots. Keep the poster and MP4 as user deliverables.
