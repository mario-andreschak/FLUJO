/** A trusted read_resource implementation returned a handled application error.
 * Never use this for arbitrary executor/transport errors or revoked ownership. */
export class NativeReadResourceError extends Error {
  constructor(message: string) {
    super(message.slice(0, 4000));
    this.name = 'NativeReadResourceError';
  }
}
