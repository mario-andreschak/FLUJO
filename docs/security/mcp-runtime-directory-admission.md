# Isolated MCP runtime directory admission

Opt-in stdio runtime isolation keeps the existing selected-workspace directory
and SHA256(serverName UTF8) first24hex identity. That hash selects a directory for
a public server name; it is not password verification. The home, cwd, environment
values, opt-in precedence, bundled Bash exemption and clone-marker paths are
unchanged. This hardening is adjacent to original alert149, without claiming that
the hash rule or native result has been discharged.

The per-server hash directory is the privacy anchor. On POSIX it must be owned by
the effective process user and have owner rwx mode0700, without group/other bits.
The real uid is used only when effective uid support is absent. The selected
workspace, userdata, shared mcp-runtime container and visited descendants must be
owned by that user and not writable by group or others. Existing0755 containers
and descendants remain valid: the private server anchor protects their contents.
The shared container may also hold clone-preparation markers, so it is not
required to be0700.

Every visited directory must be a real, non-symbolic-link directory. Only direct
children of already admitted parents may be created, using exclusive mkdir with
mode0700. Both our publication and an EEXIST winner are validated. The workspace
is never recreated. Collected BigInt dev/ino/mode/uid/gid and canonical identities
are rechecked before creating descendants, after admission and before environment
handoff. Directory timestamps, size and link count can change with child writes.

Unsafe directories fail with a fixed generic error without raw paths, owner
values or native error causes. There is no chmod, repair, deletion, migration,
retry, hash rotation or fallback to the host home. Previously accepted foreign
owners, shared writers and nonprivate server anchors now fail closed.

On Windows the type/link/canonical-identity checks still apply. Node uid/mode
fields do not establish native owner or DACL privacy; tests that model POSIX
metadata on Windows exercise policy branches, not ACL enforcement. No additional
platform skip is introduced. Existing launch-policy test skips are preserved.

The selected workspace and its ancestors remain a trust boundary. These
synchronous path checks are not descriptor-relative creation or an OS sandbox.
Parent mutation between checks, mutation after environment handoff, same-user
code and full process compromise are not excluded. No target execution or native
clearance is claimed by this Source-only proposal; qualification belongs to a
fresh exact composite and independently admitted runtime graph.
