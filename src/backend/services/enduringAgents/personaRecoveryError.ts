/** A recovery validation/conflict message that is safe to show to the owner. */
export class PersonaRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonaRecoveryError';
  }
}
