# Whether a server is OpenAI's own is decided from its address (`isOfficialOpenAiEndpoint`), never from the provider name; a self-hosted server saved as "openai" gets its messages in the order written

Enforced by:
- `__tests__/model/openaiExplicitPromptCaching.test.ts`, `__tests__/flow/selfHostedServerRuns.test.ts`
