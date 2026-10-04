// Official worker image default restore bounds. Source tests compare these
// labels to native snapshotLimits; installed smoke checks the runtime values.
// Environment overrides require separate target qualification.
export const WORKER_SNAPSHOT_ENVELOPE_READ_VERSIONS_LABEL = '1,2';
export const WORKER_SNAPSHOT_RESTORE_LIMITS_LABEL = '{"maxFileBytes":268435456,"maxUncompressedBytes":1073741824,"maxManifestBytes":8388608,"maxArchiveBytes":1082130432,"maxEncryptedBytes":1442844672,"maxMembers":65534}';
