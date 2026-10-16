/** Distinguish a hidden record identity from unavailable or malformed storage. */
export class PersonaShardIdentityError extends Error {
  readonly code = 'PERSONA_SHARD_IDENTITY_MISMATCH' as const;

  constructor(recordId: string, personaId: string) {
    super(
      `Persona record ${JSON.stringify(recordId)} does not match requested Persona `
      + `${JSON.stringify(personaId)}.`,
    );
    this.name = 'PersonaShardIdentityError';
  }
}
