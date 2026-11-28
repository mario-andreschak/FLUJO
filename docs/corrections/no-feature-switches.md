# No feature switches: a feature is on by default and falls back by itself, never behind a flag, an opt-in setting or an environment variable

Agents kept adding "experimental" toggles, code flags and environment variables
for every change, so users had to find and turn on features themselves and
nobody knew the variables existed (#1449). Every environment variable FLUJO
reads is listed with a reason in `src/shared/environmentAllowlist.ts`; only
where FLUJO runs, security limits and values FLUJO hands its own processes
belong there. Values tests need go through `testSetting()`, which ignores them
outside tests. On/off settings are only for privacy, security and real user
choices.

Enforced by:
- `__tests__/architecture/noFeatureSwitches.test.ts`
- `testSetting` in `src/shared/testSetting.ts`
- `withoutRetiredSettings` in `src/shared/config/retiredSettings.ts`
