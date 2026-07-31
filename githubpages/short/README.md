# FLUJO — Your AI. In Flow.

A 2:28 HTML5 animated product film for FLUJO. It is a zero-build, dependency-free
web experience with deterministic scene timing, an ElevenLabs narration track,
procedural Web Audio scoring, captions, seeking, fullscreen playback, and a
responsive 16:9 stage.

## Watch it

From this folder, start a local web server:

```powershell
python -m http.server 8765
```

Then open <http://127.0.0.1:8765/>.

The film needs a click on the opening play button so the browser can start audio.

## Video Studio

The project now includes a local visual production studio for editing narration,
adding voices or languages, replacing individual recordings, regenerating
selected scenes through the ElevenLabs MCP server in FLUJO, editing subtitle
cues, reviewing pacing, and publishing the result back to the film.

Start it with:

```powershell
.\tools\start-video-studio.ps1
```

Then open <http://127.0.0.1:8766/studio/>. FLUJO must be running on port `4200`
only when generating new ElevenLabs speech. Audio replacement, rendering,
subtitle editing, reviewing, and publishing work locally.

## Controls

- `Space`: play or pause
- `Left` / `Right`: seek five seconds
- `C`: captions
- `AI` microphone button: toggle the ElevenLabs voiceover; text narration stays on when disabled
- `Narrator`: switch live between Brian, Sarah, Lily, and George
- `M`: mute
- `F`: fullscreen
- Timeline arrows: seek three seconds (`Shift` seeks ten)

## Production files

- `index.html` — all eight scenes and accessible playback controls
- `styles.css` — layout, art direction, scene UI, responsive scaling
- `app.js` — deterministic 148-second renderer, transitions, audio sync, particles
- `assets/audio/flujo-voiceover-lily.mp3` — default Lily / Eleven v3 narration
- `assets/audio/flujo-voiceover-{elevenlabs,sarah,george}.mp3` — alternate Eleven v3 narrators
- `assets/audio/voiceover-scenes.json` — narration script and exact scene cues
- `studio/project.json` — editable voices, languages, scene scripts, and subtitle tracks
- `studio/` — visual Video Studio interface
- `tools/video-studio.py` — local generation, section replacement, rendering, and publishing API
- `film-content.js` — generated voice and subtitle manifest consumed by the film
- `assets/img/` — FLUJO brand and application references

For visual QA, append `?t=62` (or any second from `0` to `148`) to open directly
on a specific frame without starting playback.
