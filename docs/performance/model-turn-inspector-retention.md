# Reloadable model-turn inspector retention

The inspector previously cached every opened model-turn snapshot in a Map until the
conversation changed. Server response admission is released at EOF; that mechanism
cannot bound objects retained later in the browser or by backend callers.

The inspector cache now retains at most one complete snapshot, shared by reference
with the selected view. A cache miss clears the previous cached object before loading
another response. Previously visited dispatches reload from persisted archives.
Outcome invalidation, cancellation and conversation reset retain their existing
behavior. Canonical history, dispatch markers and active execution state are unchanged.

The cache count bound is one; the server's decoded snapshot bound remains 64 MiB.
This does not declare a total browser heap bound: UTF-16 strings, parsed structures,
Response.text/JSON.parse and inspector render allocations remain separate. React may
briefly retain the preceding selected state across a render transition. Native/backend
callers that retain returned objects also own their lifetime outside reader admission.

An offline finite profile uses 32 distinct complete, valid historical archives with
1 MiB canonical content each, actual backend object reads and the actual cache class.
The negative control uses the preceding inspector's unbounded Map policy. Each child
uses a 128 MiB heap, no explicit GC, 512 MiB supervised RSS ceiling, six warmup reads
and 26 subsequent reads, retaining the final cache for 500 ms. All 32 reads must
succeed; original persisted gzip hashes must remain unchanged. Reader admission is
zero while cache objects are retained, demonstrating its separate ownership boundary.

This measures Source object/cache behavior in Node, not a mounted browser UI or the
original provider workload. It does not qualify a maximum-size browser parse, media
hydration, native model allocations, long-running endurance or all of #569/#520.
