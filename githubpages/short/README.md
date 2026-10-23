# FLUJO product film

The published `/short/` page is a 2:28 HTML animation with narration, captions,
seeking, fullscreen playback and a responsive stage. Its voice and language
choices use the audio files in `assets/audio/`.

Serve the complete site from the repository root:

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory githubpages
```

Open `http://127.0.0.1:8000/short/` and click Play to enable audio. Space toggles
playback, the arrow keys seek, C toggles captions and F toggles fullscreen.

Unused source captures, voice samples and editing tools are kept offline rather
than published with the site.
