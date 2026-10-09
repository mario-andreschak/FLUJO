# Optional local speech

The local output provider is Kyutai Pocket TTS 3.3.0, CPU-only, with Anna (English),
Lola (Spanish) and Juergen (German). Portuguese, French, Italian and Dutch use the
published language presets. OpenRouter native speech remains a separate online
option. Pocket synthesizes text; it does not recognize speech, answer questions or
execute tools. The host's saved conversation/work engine retains those jobs.

Create an isolated Python 3.12 environment and install
`local-speech/requirements.txt`. Set `HF_HOME` to a dedicated model cache and run:

```sh
python local-speech/server.py --prefetch en es de
python local-speech/server.py --port 43947
```

Prefetch downloads public weights/preset states. Serving then requires the cache
and runs with Hugging Face offline mode. No cloning, access token or provider key is
needed. Keep this port private: the worker binds only 127.0.0.1 and rejects browser
Origin headers. Host integrations must authenticate, scope and limit their own
routes. Set server-only `FLUJO_AVATAR_POCKET_ORIGIN=http://127.0.0.1:43947` in FLUJO;
configuration alone does not establish readiness.

The server holds one language model at a time, two inference threads and one active
request with no queue. Text is limited to 600 characters and output to 31 seconds.
Language changes reload cached models. Output is mono 24kHz PCM16 WAV. Browser stop
aborts retrieval and playback; bounded CPU synthesis can finish after disconnection.
Failures never trigger paid online synthesis automatically.

The reusable Node adapter is `src/server/pocket-speech.mjs`, copied by the existing
`sync:flujo` script. Hosts should read canonical saved replies on their server for
result narration and recheck ownership before returning audio. UI guidance may use
short plain text. Browser recognition, where used, can require its browser vendor's
network service; this option does not claim fully offline conversation.

Pocket is an output renderer. A foreground conversation model must author brief
spoken replies and delegate substantial work to a separate background flow. The
local route rejects replies longer than 600 characters instead of clipping work
reports. The draft `docs/examples/avatar-conversation.flowspec.json` expresses
that split using stock detached-subflow tools. Its two workspace model IDs must be
bound to tested Codex subscription configurations: `o-conversation-codex` targets
`gpt-6-luna` with low reasoning; `o-background-codex` targets `gpt-6.1-sol` with high
reasoning. Importing a draft does not establish model access, tool availability or
live utterance delivery while the foreground run remains active.

Desktop auditions observed about 0.95GiB process RSS for Anna and about 1.06GiB for
Spanish/German. These are desktop observations, not a guarantee that Pocket plus
FLUJO/Codex fits a shared 2GB Fly machine. Measure combined peak memory and CPU before
cloud activation; no larger machine or new service is activated by this source.

Upstream: https://github.com/kyutai-labs/pocket-tts (MIT code; model and voice terms
are separate). Preset/source attribution: https://huggingface.co/kyutai/tts-voices
and https://huggingface.co/kyutai/pocket-tts-without-voice-cloning. No third-party
weights or voice samples are committed in this repository.

Attribution: Pocket TTS preset model weights, Kyutai, CC BY 4.0; Anna is the
enhanced VCTK speaker p228, sentence 023 preset, derived from the University of
Edinburgh VCTK dataset (CC BY 4.0), as distributed by Kyutai. Enhancement and
precomputed embeddings are upstream adaptations; this adapter converts generated
samples to PCM16 and does not modify the weights. Retain these credits with model
distributions. License: https://creativecommons.org/licenses/by/4.0/.
