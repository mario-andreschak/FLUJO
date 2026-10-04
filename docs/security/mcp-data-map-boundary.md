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
