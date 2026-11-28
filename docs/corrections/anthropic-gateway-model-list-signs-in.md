# The model list of an "Anthropic (Native)" connection signs in like its messages (X-Api-Key and the API version), whatever its base URL

The list request used to guess the provider from the address, so a gateway or
Microsoft Foundry behind a custom base URL got a Bearer token and no version
and refused it (#1351).

Enforced by:
- `__tests__/model/anthropicTestModelStandIn.test.ts`
- `fetchOpenAIModels` in `src/backend/services/model/provider.ts`
