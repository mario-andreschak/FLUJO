# Controlled package runner transport — SOURCE ONLY

`ControlledPackageRunnerTransport` implements the installed v1 MCP SDK
`Transport` contract using its real `ReadBuffer` and `serializeMessage` framing.
An explicit caller can pass it to `Client.connect`. The ordinary transport
factory and trusted-host npx denial are unchanged. No production route selects
this candidate, and beta SDK compatibility is not asserted.

Start requires the actual owner bearer request, an opaque prepared intent and
the authoritative enabled server name. The actual guarded spawn holds owner,
separate runner ledger and configuration descriptors through final native and
full-byte checks. It snapshots the real request principal and all authority
values. Subsequent writes require that exact captured principal and authority,
re-read configuration, revalidate the intent, and execute stdin.write directly
after the final synchronous fence. There is no runtime grant provisioner here.

Stream listeners install synchronously at the actual spawn, before asynchronous
authority disposal. Parsing is bounded to 256 KiB; writes are bounded to 256 KiB
each and sixteen pending operations. The wire-size check occurs **after** SDK
serialization; it does not bound serialization allocation of caller objects.
Stderr drains without retained output.
Failure/abort retires dispatch. Close waits for start settlement, then attempts
parent termination within five seconds; actual exit, child close and both stream
end events and actual nonrejecting settlement witnesses for every admitted
dispatch are required before releasing parent ownership or emitting onclose.
Abort does not settle those witnesses. Start/dispatch failure retains ownership;
close reports failure instead of claiming successful release. Timeout preserves
ownership and permits another close attempt. Held authority handles remain
strongly retained on close failure, with disposal available on the thrown error.
Real held-file read/close barrier controls exercise the exact dispatch drain;
they remain unrun and do not qualify a child launch or complete transport close.

This is an explicitly **modified-npm** candidate, not an original stock-npx
positive. No test, typecheck, runtime grant, registry/provider access, reify,
Windows launch or SDK handshake was run for this Source leaf. Security source
review and serial runtime qualification remain required.

The native ACL checks do not make the final validation/effect OS-atomic against
a malicious same-account writer. Parent exit/drain is not Windows Job Object or
owned-descendant containment proof. Runtime module import fallback, controlled
npm options, compatible actual archives and application environment keys still
need qualification. The original stock-npx requirement remains open.
