/**
 * FLUJO package manifest format — `FlujoPackage` v1 (issue #192).
 *
 * Barrel for the shared types, Zod schema, and pure (de)serialization helpers
 * that every "Packages" feature (wizard, secret derivation, registry API,
 * install flow) builds on. Pure/isomorphic — safe to import from the browser,
 * the registry API, and the installer.
 */
export * from './constants';
export * from './secrets';
export * from './secretProposal';
export * from './installOrigin';
export * from './package';
export * from './package.schema';
export * from './package.serialize';
