# Source provenance

The native voice stream parser, playback ledger, microphone collector and WAV utilities were extracted from the user-owned avatar proof of concept. Domain-specific adapters, banking prompts, identity and account routes are excluded. The generic protocol is adapted to awaited event sinks for Flujo's Web Streams routes.

Flujo includes a synchronized copy under `src/vendor/avatar`, with per-file SHA-256 hashes. Changes originate here and are synchronized with `npm run sync:flujo -- <Flujo checkout>`. This preserves one editable source while keeping Flujo's standalone npm distribution self-contained.

The OpenRouter adapter accepts complete utterances and streams native audio. It is an endpointed HTTP conversation transport; persistent live duplex transport remains replaceable future work. The output sample rate remains the reviewed 24 kHz packaging assumption and is explicitly reported by the protocol.

The canonical World presentation inputs are copied without modification from FLUJO commit `3d85f2df3070d1b92aea68732cdeda028d30e6ac`. Their SHA-256 provenance is included at `src/world/canonical/MANIFEST.json`. Those inputs carry the following license:

MIT License

Copyright (c) 2025 mario-andreschak

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
