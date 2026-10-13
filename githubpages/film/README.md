# Build a website with FLUJO

A silent guided walkthrough of one real workspace: connect an AI model and a
useful tool, save a reusable Website Builder, then build and improve the First
Pour coffee-workshop website in its chat. The website payoff comes before the
brief tour of Meetings, Automations and Personas.

Watch the HTML player or [download the finished video](flujo-guided-walkthrough.mp4)
(84 MB). The film lasts **19:36.3**, with a silent 1280 × 800, 30 fps MP4 at 1×.
The player also offers 2× and 5× playback. See [validation.json](validation.json)
for the final implementation, media checks and measured review scope.

## Watch or follow the written steps

Serve `githubpages/` over HTTP and open `/film/`. For example, from the repository
root:

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory githubpages
```

Open `http://127.0.0.1:8000/film/`. Use the chapter buttons or timeline to revisit
a step. Choose 1×, 2× or 5× with the Speed control; the MP4 plays at 1×.
Space plays or pauses, the arrow keys move five seconds, Home/End jump to
either end, and F toggles fullscreen. Gentle motion reduces movement. Fullscreen
gives small interface text more room; the whole application keeps its 16:10
shape on narrow screens.

The [Website Builder guide](../guides/website-builder/) provides the setup values,
reusable instructions and project brief. The player's expandable transcript and
recording notes explain what was recorded, shortened and checked.

## Story and recording

| Chapter | What the recording demonstrates |
| --- | --- |
| Connect the AI | A saved model connection and a successful live model/tool test. |
| Connect a useful tool | A GitHub clone and build, followed by the manual launch configuration, a test discovering 26 tools and a saved Connected card. |
| Save Website Builder | Generic instructions, the tested AI and connected app, saved status, Easy and Expert views of the same agent, and its new chat. |
| Build and review First Pour | The real brief and tool calls, an incomplete first revision, an operator-directed repair, and the resulting local website. |
| Check the result | Operator signup and reload checks on desktop. The signup is a local demo. |
| Explore the workspace | Meetings, Automations and Personas after the website result. These views do not establish completed scheduled work. |

The preserved source frame is 1600 × 1000. Whole-app views establish location;
target borders and smooth closeups make the real controls and results readable.
Recorded actions play at normal speed at 1×. Narration and reading holds determine the
length; there is no one-minute limit. Text cards allow at least 1.5 seconds plus
one second per 2.5 words, with longer holds for unfamiliar settings or results.

The editorial pointer follows logged click positions and times. Its travel is
interpolated between targets, with a neutral initial pose where needed; it is
not measured native cursor motion. Recorded pastes appear at once. The film does
not generate typing, clicks or application state. Routine operator pauses and
clipboard preparation are omitted. Shortened installation or AI waits are
identified on screen. Private key entry and correction are omitted and disclosed
in the recording notes.

Two approved still images show the original draft's hero and signup before the
revision. The later preview and signup sequences show the repaired site. The
closing tour uses brief recorded feature views, with no claim to demonstrate
their full setup or execution.

The first website revision claimed success but failed the operator's source
check. A follow-up requested a read, one complete `write_file` correction and a
readback. The agent's response reports its checks; separate operator footage
demonstrates the final desktop browser behavior. The signup sends no data,
makes no reservation and delivers no email.

## Implementation and evidence

- `timeline.js` defines shots, source intervals, action timing, chapters and the
  export gate. Duration is derived from the assembled shots.
- `renderer.js` draws narration, camera movement and guidance over genuine
  source pixels. `player.js` synchronizes playback and seeking, including source
  preparation, loading/error states and reduced motion.
- `media/walkthrough/` contains reviewed public source media. Capture manifests
  retain exact media hashes, dimensions, provenance and actual action maps.
- [Build and revision footage](../../docs/journeys/evidence/walkthrough-build-clip.json)
  distinguishes the initial result, incomplete revision and repaired preview.
  [Site acceptance footage](../../docs/journeys/evidence/walkthrough-site-clip.json)
  preserves the final desktop and responsive-browser interactions. The phone-width
  chapter and Waves are omitted from this film at the user’s request.
- [validation.json](validation.json) links the setup, tool and agent evidence and
  records which implementation revision each check covers. Reviewed source
  footage alone does not establish acceptance of the assembled film.

## Validate and export

Run the player checks from the repository root:

```sh
node githubpages/film/tools/verify.mjs
```

The tool reuses an installed Playwright module. Set `PLAYWRIGHT_MODULE` to its
existing path if normal Node resolution cannot find it. Checks cover source
hashes and provenance, playback and seeking, holds, mapped clicks, loading/error
recovery, controls, playback speeds, silence, reduced motion and
desktop/narrow/phone player layouts.
Screenshots are retained only when `FILM_QA_OUTPUT` is set.

The assembled player passed all 19 checks in 212.3 seconds, covering 472 frame
samples. Complete decoding verified all 35,289 frames and continuous timestamps;
the joined MP4 matches the two rendered parts exactly in decoded frame order.
Opening, splice, website payoff, edited transitions and ending received visual
playback checks. Earlier continuous chapter reviews and parent samples retain
their separate scopes in the receipt; no continuous whole-film review is claimed.

The subsequent startup recovery fix passed four focused checks in 72.8 seconds.
A controlled delayed seek reproduced the old failure; bounded preparation and
one timeout retry recovered all 58 clips. Persistent failures retain a visible
reload control. Old and new players matched every pixel at 95 timeline positions,
so the verified MP4 remains unchanged. The receipt separates these follow-up
checks from the earlier full suite.

To reproduce an accepted export:

```sh
node githubpages/film/tools/render.mjs
```

It requires `FILM.stage === 'final'` and `FILM.exportReady === true`, and reuses
Playwright and FFmpeg (`FFMPEG_PATH` can specify an existing binary). Both gates
remain required. Bounded review renders require
`--prototype --start <seconds> --end <seconds>` with endpoints on the film's
frame grid. Validate any replacement MP4's duration, frame count, full decode and
visual seams against its frozen timeline before exposing the download.

Use flujo-bash MCP for all cleanup and deletions. Preserve genuine source media,
provenance, active services and deliverables. Keep current validation and pending
delivery work in `validation.json` rather than duplicating approval history here.
