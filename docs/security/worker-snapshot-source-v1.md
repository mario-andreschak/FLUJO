# Private worker snapshot sources

An explicitly configured full-workspace worker can become a source for a later
hot clone. Set `FLUJO_WORKER_SNAPSHOT_SOURCE=1` together with worker mode and
network exposure. The existing dedicated snapshot-control bearer authenticates
the request in both the proxy and handler. The handler also checks the network
Host/Origin policy, completed bootstrap and an explicitly assigned workspace
equal to the selected workspace. These checks precede selection-body reads and
snapshot coordinator calls. Public exposure is refused.

Desktop installations and workers without the exact opt-in retain the existing
strict-loopback snapshot control plane. The opt-in does not enroll schedules,
resume imported agents or create execution authority.

`workerCompatibility.workerSnapshotSourceVersion: 1` reports support for this
source contract. A consumer using the new private-workspace profile must require
this marker and the target OCI label `io.flujo.worker.snapshot-source="1"`,
binding both to the actual immutable worker image/build revision. Official image
publication checks this label before accepting or promoting the tested image.
The marker does not establish active configuration, deployed identity, native
coding/tool containment or release acceptance. An old image missing the marker
must not be treated as supporting the opt-in merely because its environment
contains the new variable. Existing protocol and archive format versions remain
unchanged.

An empty begin selection captures the full workspace. Explicit `flowIds` retain
their current selected-flow behavior. Session ownership, capture cancellation,
workspace mutation fences, portable MCP preflight and archive validation remain
the existing coordinator's responsibility. The paired cloud deployment profile
must persist its selection, assigned workspace, worker identity/epoch and source
pin across calls/restarts, and must expose no public worker service.

Source tests exercise the real bearer, Host/Origin policy, workspace ALS and
readiness through the snapshot handlers with a synthetic coordinator. They do
not qualify an installed image, cloud network, model/provider or restored live
workspace; those require exact artifact and deployed observations.
