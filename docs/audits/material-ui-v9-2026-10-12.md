# Material UI 9 compatibility qualification

This batch completes the existing paired dependency updates in [#1036](https://github.com/mario-andreschak/FLUJO/pull/1036) and [#969](https://github.com/mario-andreschak/FLUJO/pull/969). Updating either package alone fails normal npm peer resolution: Material UI 9.4 and icons 6.5 require incompatible Material UI peers. Installing both packages at 9.4 succeeds without bypassing peers, but the unchanged application then reports 744 TypeScript diagnostics.

## Changes

- Material and icons are locked at 9.4.0. Their normal dependency ranges resolve the remaining MUI support packages to 9.5.0 and `react-is` to 19.3.0. Unrelated unchanged-version platform selectors and workspace metadata retain their main-branch values.
- Removed `Outline` icon exports use their equivalent `Outlined` exports; rounded variants retain their existing names.
- TextField adornments, native input labels and limits, select options and helper props use their corresponding slots. Checkbox, Radio and Switch labels move to the native input slot. Password visibility, numeric constraints, maximum lengths and read-only fields remain functional.
- Box, Stack, Typography and Grid system props move into `sx`, preserving existing `sx` priority. Grid item breakpoints move to responsive `size` values.
- Dialog, Drawer and Menu paper/list/transition props move to slots. Required encryption setup retains its non-dismissable close handler. Picker exit callbacks retain focus restoration.
- The model autocomplete retains both input and native-input parameters from MUI 9, including popup refs, keyboard handlers, adornments and loading state. Nested menu and typography slots use the new APIs.
- Primary button overrides use the surviving composed classes, preserving the existing gradient, focus and contrast rules. Security gates, CI definitions and Calendar/Day scheduling entry remain intact.
- The production filesystem App check exposed an unnamed full-screen icon button. It now uses the existing translated Full screen/Exit full screen labels, including while capabilities are loading or unsupported. Its owner-handshake regression and real full-screen/close checks pass.

The API mappings follow the official [v7 guide](https://mui.com/material-ui/migration/upgrade-to-v7/) and [v9 guide](https://mui.com/material-ui/migration/upgrade-to-v9/). MUI 9's browser floor is Chrome 117, Edge 121, Firefox 121 and Safari 17 on desktop and iOS. The local qualification below uses Chromium and responsive phone emulation; it does not assert a separate Firefox, Safari or physical-device qualification.

## Local evidence

The candidate includes actual main `6cd92a01bc8b54daf4808177093089590d6db06c`, which contains the independently qualified MCP Apps 2 migration. Final runtime source was frozen at tree `dae0c2a126772390dfd94791e654a4f7617245ce` after lockfile metadata normalization and the full-screen label correction. The final qualification is bound to that source and build `oixomALxrVNeycLqSJohB`. [Machine-readable receipt and screenshots](evidence/material-ui-v9-2026-10-12/receipt.json).

- Typecheck, including Next route type generation: passed, 67.715 seconds.
- Application ESLint: passed, 112.376 seconds.
- Focused component, model modal, menu, theme and App owner-handshake runs: 158 passing assertions across 16 suite executions; NavigationQuickActions was repeated after its nested menu migration. Assertions and suite-selection checks remain intact. The initial runner correctly refused an accidentally selected Node theme suite in the jsdom project; that suite passed under its actual Node project.
- Final non-container `npm run build`: passed, 285.349 seconds. The preceding build passed in 338.483 seconds before the adjacent label correction.
- Actual production Chromium 153 journey: all 23 checks passed in 26 seconds at 1440x1000 and 390x844, with zero page errors or horizontal overflow. This includes fresh password setup/unlock, visibility and required-dialog behavior, guided connection choices and empty-key recovery, nine affected screens, desktop calendar navigation and phone date-picker focus recovery.
- Actual bundled filesystem App: all nine steps passed at 1280x800 and 360x800. It listed a real directory, previewed a real file, recovered from a real denied parent read, entered/exited full screen through accessible controls and closed cleanly. App-initiated tool calls were observed; both owned applications exited normally (143), with drained filesystem-app pipes and no forced stop.

The browser checks ran concurrently; their durations are separate observations. The general runner was corrected for its operator-key placement, initialization/verification timing, actual dialog/card names and the phone picker's existing focus contract. Those rejected attempts are retained locally and are not claimed as successful acceptance. No real account credentials appear in the versioned evidence.

Focused commands use `scripts/run-local-jest.cjs` with explicit suites in `__tests__/frontend/components` (EncryptionAuthDialog, CardPickerDialog/Grid, ModelConnectionWizard, ModelClientNavigation, NavigationQuickActions, SchedulePanel, DayViewAccessibility, InstallPackageCard, NodePalette, ModelModalLocalAuth/CodexDiscovery, WorkspaceTabs and McpAppOwnerHandshake) and `__tests__/frontend/themePresets.test.tsx` in the Node project.

The build command was inspected: it builds the five existing MCP workspaces and the ordinary Next webpack application. No container/image build, full test suite, online CI, installer or release workflow was dispatched. Those broader checks remain release pre-flight under the existing pause.
