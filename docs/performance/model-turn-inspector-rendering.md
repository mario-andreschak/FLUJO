# Bounded model-turn inspector rendering

The inspector previously formatted complete request objects and every message with
JSON.stringify and mounted their complete text in pre elements. A scroll container
limits the viewport, not serialized text or browser layout allocation.

Each text view now displays at most 64 Ki UTF-16 characters. The formatter traverses
archived JSON lazily, escaping strings in small chunks and keeping an iterative stack;
it does not stringify an entire large object or collect its entire property list.
Previous/next text pages make the complete captured value accessible. Ordinary JSON
formatting is unchanged; deep indentation is capped at 256 spaces without changing
JSON values. Plain string parameters retain their original unquoted display.

Canonical and wired views mount at most 16 messages at a time, with at most one text
page each. Message pagination preserves original numbering and complete history.
Provenance lookup retains entries for the visible messages only. Request parameter
selectors, existing request-parameter-value selector and outcome metadata remain.

Actual browser qualification bundles the real inspector, chat service and single-entry
cache from Source, mounts React/MUI in isolated Chromium, and serves offline JSON
fixtures through loopback HTTP. Each of 32 loads contains 1 MiB of canonical history,
the same complete wired history and SDK input, plus 40 smaller messages. Checks recover
all 16 request pages by SHA-256, navigate all 41 canonical messages, switch wired/request
views and adapter parameters, update outcome display, and verify original AbortError
and typed 404/429 handling. Six loads are warmup; 26 subsequent loads and a final 500 ms
hold collect browser JS heap, DOM/layout counts and supervised process RSS.

The predeclared renderer limits are a 128 MiB JavaScript heap and 512 MiB RSS, with a
90-second supervisor deadline and no forced GC. All browser process RSS is also
reported separately. Source/module hashes and frozen revision bind the receipt.
The preceding complete Source browser control exposes the full request text and all
messages, failing the new display bounds for the expected reason.

This profile uses the actual browser fetch/JSON parse and inspector, but a disposable
harness mounts it instead of the complete Chat page. The offline server is a fixture,
not the authenticated backend route. Server response proof remains separate. Maximum
64 MiB browser parse transients, large media hydration, native/backend caller-owned
objects, whole-Chat effects, provider workloads and endurance remain unqualified.
