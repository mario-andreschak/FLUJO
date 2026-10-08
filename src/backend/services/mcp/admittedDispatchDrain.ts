/** Settlement witness only; cancellation never completes an admitted operation. */
export class AdmittedDispatchDrain {
  private sealed = false;
  private readonly operations = new Set<Promise<void>>();
  private readonly rejected: unknown[] = [];
  constructor(private readonly changed: () => void = () => {}) {}
  get pending(): number { return this.operations.size; }
  get failures(): readonly unknown[] { return this.rejected; }
  admit(run: () => Promise<void>): Promise<void> {
    if (this.sealed || this.pending >= 16) return Promise.reject(new Error('Dispatch admission retired or full'));
    const operation = Promise.resolve().then(run);
    const witness = operation.then(() => {}, error => { this.rejected.push(error); });
    this.operations.add(witness);
    void witness.then(() => {
      this.operations.delete(witness);
      try { this.changed(); } catch { /* Observation cannot falsify settlement. */ }
    });
    return operation;
  }
  seal(): Promise<void> {
    this.sealed = true;
    // Every witness is nonrejecting and remains pending through the actual
    // operation's reads, revalidation, held close and writer-lock cleanup.
    return Promise.all([...this.operations]).then(() => {});
  }
}
