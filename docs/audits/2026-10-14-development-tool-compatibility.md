# Supported development-tool updates

Existing Dependabot PR #1135 is adjusted against main `1616b516a1acda1fa13a7f1eaf1f41e061acb2df`. The original group changed TypeScript to 7, ESLint to 10 and Node declarations to 26 together. That combination does not resolve normally with FLUJO's existing lint plugins and compiler API consumers.

The compatible candidate updates `@types/lodash` from 4.17.25 to 4.17.26 and `@types/node` from 22.20.1 to 22.20.5. All five MCP workspace manifests use the same Node 22 declarations as the application. The lockfile changes only those two installed package records and their declared ranges; other runtime and development package records remain identical to main.

## Compatibility decisions

- Retain TypeScript6.0.3. Locked parser8.71.1 accepts TypeScript versions below6.1 and explicitly rejects7. Next16.4 can invoke the new CLI, but existing `nextConfig.test.ts` and `smoke-bundled-operator.mjs` consume the JavaScript compiler API, which TypeScript7 lacks. The installed Next TypeScript and ESLint guides were read before the adjustment.
- Retain ESLint9.39.5. A normal `npm install --package-lock-only --ignore-scripts --audit=false --fund=false` with TypeScript6 and supported Node22 declarations still reproduced `ERESOLVE` for `eslint-plugin-import`2.32.0, whose peer range excludes10. The current React plugin7.37.5 also excludes10. The compatible lock resolves normally, without forced or legacy peer resolution.
- Keep Node declarations on22, matching the oldest advertised runtime (`^22.17.0 || ^24.2.0`). Node26 declarations would admit APIs that the supported runtimes do not provide.
- Dependabot ignores TypeScript7 and ESLint10 version updates while these concrete compatibility gaps remain, and ignores Node declaration major updates while Node22 is supported. Compatible patch/minor updates remain eligible. Revisit the compiler hold when the actual API consumers and parser support7, the lint hold when its plugins support10, and the declaration hold when the oldest supported runtime changes.

## Validation

Qualification passed on Node 22.23.3 and Next 16.4.0. The normal locked install completed with lifecycle scripts disabled, without forced or legacy peer resolution. The unchanged Antigravity download/install path is outside this declaration update.

| Local check | Result | Measured seconds |
| --- | --- | --- |
| Application typecheck, including tests | Passed | 66.998 |
| All five MCP workspace typechecks | Passed | 9.326 |
| Whole-source lint | Passed | 109.570 |
| Existing configuration/compiler API suite | All 5 cases passed | 4.954 |
| All five MCP package builds | Passed | 10.028 |
| Application production build, all 133 pages | Passed | 324.068 |

These are separate measured phases; typechecks, lint and the focused suite overlapped. The application build command and all five workspace build commands were inspected and contain no Docker/container image build. Heavy builds used the existing process-held lease. Build ID: `qz4w--fm-XoUYGccLtA22`. The installed dependency tree resolves TypeScript 6.0.3, ESLint 9.39.5 and Node declarations 22.20.5 consistently in the application and workspaces. The Dependabot YAML parses and its version ranges match the rejected majors. Qualification finished at `2026-10-14T05:14:16.705Z` with all bound inputs unchanged.

| Qualified input | SHA-256 |
| --- | --- |
| package.json | 55676c7c13fec045eb1abac9924cd2851bd0e9a0f845adb3b6f66c375f70be1d |
| package-lock.json | f55e75de0393157756e75e010ee7dc5d77068ca628f6bb913acec0509db105a8 |
| .github/dependabot.yml | f962532ca458c42cbed8bbe66f9ca71f780904a6848323c74703fc47eace94f0 |

This is development qualification for the declaration changes and compatibility policy. Existing UI/provider behavior is unchanged. Hosted-provider, broader/installed/container suites and release pre-flight were not repeated; no workflow was dispatched or CI gate altered. No issue closure or release is claimed. The published candidate and actual main result must share the qualified Git tree.

## Daily review

The2026-10-14 Bogotá upstream/security review found the existing development-scope sprintf-js advisory42 still open, without a patched release. All43 watched historical closures and the additional open documentation issue518 are unchanged; its upstream FastMCP PR5036 remains closed and unmerged. Claude Agent SDK0.3.299 has new optional cron/form fields, rewind/message fixes and MCP server-name handling; its existing genuine-access hold and owned acceptance lane remain separate from this candidate. No new issue or feature was created.

Separate existing PR #1140 still needs its Undici8 Node22.19 minimum reconciled with advertised22.17 support. Existing issue #570 retains its original integrated restart/provider/migration/approval/scheduling, independent-operator and supported-release acceptance criteria.
