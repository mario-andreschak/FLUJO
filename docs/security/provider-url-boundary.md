# Provider catalogue URL boundary

The provider name is now inferred from the parsed HTTP/HTTPS hostname rather
than substring matches against the entire URL. This targets CodeQL alerts
[14](https://github.com/mario-andreschak/FLUJO/security/code-scanning/14),
[15](https://github.com/mario-andreschak/FLUJO/security/code-scanning/15),
[16](https://github.com/mario-andreschak/FLUJO/security/code-scanning/16), and
[154](https://github.com/mario-andreschak/FLUJO/security/code-scanning/154).
Provider text in another host, user info, path or query no longer selects that
provider's header format or OpenAI chat-model filter. Azure resource domains,
Requesty/OpenRouter whole-domain suffixes, case/trailing-dot normalization and
configured local/LiteLLM endpoints remain supported.

This is provider recognition, not an outbound endpoint allowlist. Explicitly
configured local/custom endpoints still receive their normal catalogue request.
Catalogue requests refuse redirects to prevent forwarding provider credentials
to another endpoint. An operator using a redirected catalogue URL must enter
the final base URL. Failure diagnostics omit URLs, raw upstream errors,
responses, headers and unrecognized response bodies; thrown errors use a fixed
message. This does not claim to redact every model-service or frontend logger.

At base `d6ffb0b29ec7abaf3c8e57d85aa35bb36e29019b`, 61 focused tests across four
suites passed on Windows with locked Next 16.3.8 dependencies. Tests cover
host/userinfo/path/query confusion, correct provider selection, preserved local
and proxy support, header and filter behavior, redirect refusal options and
credential/error/body omission from diagnostics. Existing provider catalogue
normalization tests passed. Changed-file ESLint and diff checks passed. Network
requests were mocked; no live account/provider call or installed-release result
is claimed. Full type/build and a fresh integrated scan remain required. No
scanner policy change or alert dismissal is included.

Related medium file-to-network findings 215/216 need separate review of the
stored-model credential destination boundary. This hostname correction alone
does not establish that an unsaved destination/profile change can safely reuse
a stored model credential. That follow-up remains open.
