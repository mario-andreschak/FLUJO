# Windows launch command data

The Git updater keeps its existing `cmd /c start` detached PowerShell launch.
Checkout paths are now single-quoted PowerShell literals, with apostrophes
doubled, inside a UTF-16LE encoded command. The only variable command argument
seen by `cmd` is base64. Legal directory characters such as `&`, `%`, `!`,
parentheses and apostrophes therefore remain path data. Local-request, unlock,
official-origin, clean-checkout and both fast-forward preflight checks remain
before the updater launch.

The packaged CLI validates and canonicalizes its port to an ASCII decimal
integer from 1 through 65535 before preparing its data directory or starting
Next. Next arguments, instance discovery and the browser URL use that same
value in every exposure mode. The port helper is under `bin/`, which is included
by the existing npm package file list.

Source review found these conditional command-data gaps in the published
`a4d9cc564cf021eb1857ab8e6618f07c05453354` candidate at the updater and browser
opener sinks. No command-injection probe was executed. These changes do not
establish a remote authorization bypass or native CodeQL clearance.

Authored regression cases extend the complete update-route suite with three
path vectors and add 26 port cases in `scripts/launcher-port.test.mjs`. They
require fresh qualification; previous candidate results do not transfer.
Windows acceptance must also verify that the encoded updater receives the
exact script/directory, starts hidden, survives server shutdown, and preserves
the normal update/restart behavior. The regression cases decode command data
without launching a shell or changing a real installation.
