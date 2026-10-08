# Provider catalogue credential fingerprints

The saved original #813 finding 151 traces resolved API credentials into an
unkeyed SHA-256 digest used in the provider catalogue cache identity. This is an
in-memory account-sensitive cache key, not a password verifier. API credentials
can be arbitrary strings; an exposed unkeyed digest permits checking candidate
credentials even when they are not high entropy. No existing public disclosure
or actual attack is claimed by this Source correction.

The owning `ModelCache` instance now generates a private 32-byte random key and
uses HMAC-SHA256 with the domain `flujo:provider-catalogue:credential:v1` followed
by NUL and the resolved credential. Only the 64-character hexadecimal fingerprint
enters the existing cache identity. The key is a JavaScript private field, is
never persisted or returned, and lives with that cache instance. The service
resolves credentials before cache lookup, so equivalent encrypted/global/plain
forms still share an entry when they resolve to the same credential. A changed
credential remains separate, including from the unauthenticated identity.

Workspace, endpoint, provider, adapter, profile, TTL, search filtering,
destination-bound stored-key reuse and omitted credential diagnostics retain
their existing behavior. A new cache lifetime generates a new key and cold
entries; no durable records need migration. Persistent statistics grouping
(finding 120), stdio runtime directory identity (finding 149), credential storage,
provider/SDK configuration and dependencies are unchanged.

New regressions cover resolved-credential reuse/separation, fresh module
lifetimes, the public unkeyed digest comparison, options/workspace separation,
and omission of credentials/fingerprints from service and cache diagnostics.
They use synthetic credentials and mocked provider/storage seams. This Source
freeze precedes target execution; planned regressions are not passing results.
The original scan and failures remain preserved. HMAC does not protect a complete
process-memory compromise, and this change makes no formal alert disposition or
native clearance claim.
