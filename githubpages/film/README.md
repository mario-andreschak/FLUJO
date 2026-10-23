# Build a website with FLUJO

The published `/film/` player shows how to connect an AI model and tools, save a
reusable Website Builder, and build and revise a coffee-workshop landing page.
The silent walkthrough lasts 19:36.3. The player supports chapters, seeking,
fullscreen and 1×, 2× or 5× playback. The downloadable MP4 is 84 MB.

Serve the complete site from the repository root:

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory githubpages
```

Open `http://127.0.0.1:8000/film/`. Space toggles playback, the arrow keys seek,
Home and End jump to either end, and F toggles fullscreen.

The [written guide](../guides/website-builder/) includes setup instructions and
the site brief. The demonstrated signup is a local demo and does not register
attendees. Connected models and tools have their own access and cost settings.

`captures.js` declares media loaded by the interactive player. Keep those clips,
the downloadable MP4, and screenshots used by maintained guides. Unused source
captures and production tools are kept offline.
