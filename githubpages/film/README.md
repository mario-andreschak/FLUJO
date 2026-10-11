# FLUJO in 60 seconds

A silent product film showing how FLUJO connects an AI, tools and instructions into
a reusable agent, then extends work through experimental Personas.

## Watch

Serve `githubpages/` as a static directory and open `/film/`. The player has
play/pause, replay, seek, fullscreen, a reduced-motion option, and a seekable
transcript. It does not autoplay, and pauses when the tab is hidden.

The page uses a wide desktop composition and a separate portrait composition.
`?t=26` opens a paused preview; `?render=1&t=26` exposes only the canvas.

## Product story

| Time | What the viewer sees |
| --- | --- |
| 0–5 | FLUJO: build AI assistants with your own AI and tools |
| 5–12 | Choose and test an AI connection |
| 12–20 | Import a GitHub tool and verify its MCP connection |
| 20–32 | Instructions, AI and tools in the same saved agent |
| 32–43 | Inspect the agent’s tool use and result |
| 43–54 | A Persona goal, reviewed memory and completion |
| 54–60 | FLUJO and a direct invitation to try it |

Source interface pixels are genuine recordings. Editorial crops, camera moves,
framing and captions explain the product without reconstructing its UI or
manufacturing cursor actions. `captures.js` maps images and reviewed clips to the
film; `renderer.js` defines the camera choreography. `player.js` synchronizes
recorded video to the same 60-second timeline used by the exporter. Reduced
motion replaces camera movement and recorded motion with held frames.

The genuine clips show the Easy/Expert switch, selection of an AI task, and
inspection of an already completed tool call. They do not show a new model run.
The [supplementary capture manifest](media/product-capture-manifest.json) records
source offsets, action times, hashes and the limits of the privacy review.
Small clips are buffered once as local browser blobs so deterministic seeking
also works with static servers that do not support HTTP Range requests.

The example task is demonstration data, not the film's subject. The source
checklist was corrected after a complete read, but retains imperfect temperature
wording outside the film's output crops; the Persona required operator
review, resumption and approval. The demonstration compresses work sessions and
does not establish unattended reliability. Detailed evidence remains in the
[journey provenance](../../docs/journeys/evidence/capture-provenance.md) and the
[reviewed workshop pack](../../docs/journeys/evidence/workshop-pack.md).

## Reproduce

The tooling reuses an installed Playwright. Set `PLAYWRIGHT_MODULE` to an existing
module path if normal Node resolution cannot find it. FFmpeg and ffprobe must
already be available.

```powershell
node githubpages/film/tools/verify.mjs
node githubpages/film/tools/render.mjs githubpages/film/flujo-product-60s.mp4
ffprobe -v error -show_entries format=duration:stream=codec_type,nb_frames,r_frame_rate -of json githubpages/film/flujo-product-60s.mp4
```

The exporter renders frames 0–1799 at `frame / 30`, streams them directly to
FFmpeg, and produces a 60-second H.264 file with no audio track. It creates no
intermediate frame directory. Its browser and local server close on completion.

For a single frame:

```powershell
node githubpages/film/tools/render.mjs githubpages/film/poster.png --poster --t=3
node githubpages/film/tools/render.mjs C:/path/to/phone-frame.png --poster --portrait --t=26
```

Use flujo-bash MCP for all cleanup or deletion. Preserve the final poster, MP4,
reviewed media and provenance. The existing `../short/` experience is unchanged.
