# Historical package identity test fixture type correction

Hosted run `37171644606`, typecheck job `111345611456`, failed at frozen #678
head `a489b56e8d6acc973968fd37d481c75554ab7a4a`. Two new installer fixtures
assigned process-node properties to a fixture whose original node properties
were inferred as `{ subflowId: string }`. The pure schema test also accessed
optional node properties without narrowing them. These were three TypeScript
errors in tests, even though the focused runtime tests passed.

The correction constructs each process-node fixture with its intended shape
instead of mutating the differently shaped subflow fixture. The pure test uses
optional property access after its successful-schema assertion. It changes no
production code, assertions, compiler options or manifest/dependency files.

All 154 package assertions pass again across seven focused suites. The pure
test and its 34 source dependencies pass a scoped TypeScript check; changed-file
ESLint and diff checks pass. The full installer test import graph remains for
root/hosted CI, so this receipt does not claim a full application typecheck.
The original failing hosted run remains part of the qualification evidence.

That same run's Windows production job failed installed startup with repeated
`WORKSPACE_LAYOUT_NOT_STARTED` responses. This test-only correction does not
resolve or qualify that separate installed-startup boundary. Root's integrated
candidate, fresh scanning, installed/human/external acceptance remain pending.

The current integration restores these fixture shapes and optional accesses,
while preserving SHA-256 flow IDs and recorded legacy ownership. The checks
above describe the original correction, not qualification of the current source.
