# MCP own data maps

This source correction addresses remote property injection at the assigned MCP
tool normalization and connection map paths (CodeQL alerts 194–204). Ordinary
tool normalization enumerates own argument entries and defines the result with
`Object.fromEntries`. A parameter named `__proto__`, `constructor`, `prototype`
or `toString` remains serializable business data without invoking a prototype
setter. Inherited parameters are excluded. Existing null/undefined defaults and
tool timeout/progress behavior remain unchanged.

Resolved environment/header maps, header flattening and stdio environment
transformation use dictionaries with no prototype. This preserves special-name
entries while avoiding the setters/inherited values of ordinary objects. The
private execution extension's separate argument/dispatch admission remains
unchanged. This patch does not claim to harden every other header helper or
every configuration map in the repository.

At base `d6ffb0b29ec7abaf3c8e57d85aa35bb36e29019b`, the focused Windows run
passed 35 assertions across five suites with locked Next 16.3.8 dependencies.
Regressions verify actual tool-layer dispatch serialization, inherited argument
exclusion, existing defaults, special-name connection maps and normal stdio
launch construction. Existing timeout/progress, masking and runtime-home tests
passed. No external tool/server is invoked by these regressions. Changed-file
ESLint and diff checks passed; full graph TypeScript/build and fresh integrated
CodeQL verification remain with root.

The first run retained two fixture failures: a property matcher rejected a null
prototype, and `Object.assign` in a test discarded its own `__proto__` value.
The fixtures now construct own data properties and assert serialization and
boundary behavior directly. No assertions or scanner rules were disabled.
This is source evidence; installed-release, human and external Security
reassessment boundaries remain open.

## Follow-up on the original #813 findings

The original #813 scan still reports high findings 194–198 in connection map
assembly. Its existing null-prototype dictionaries are retained as the baseline
protection; the scan count alone does not establish an exploit or a closure.
The follow-up assembles values in `Map` and defines own data properties with
`Object.fromEntries`, retaining a null prototype and valid special-name data.
Header names must be HTTP field-name tokens (RFC 9110 section 5.6.2); environment
names cannot be empty or contain `=` or NUL. Invalid names are dropped before
credential resolution. Values must be strings or own string-valued `value`
fields, so inherited values and malformed record shapes cannot reach resolution
or launch construction. The stored config stays unchanged.

`connectionDataBoundary.test.ts` supplies regressions for these admission rules,
credential-resolver non-entry, own special names, temporary binding resolution,
header flattening and stdio launch construction. The source freeze precedes
target execution; test outcomes and a later native scan's disposition must be
recorded separately. Saved-header destination guard #770 remains present. Package
public-identity proposal #678 is separate and is not imported by this change.
