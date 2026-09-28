export class BankingError extends Error {
  constructor(readonly code: string, readonly status = 403) {
    super(code);
    this.name = 'BankingError';
  }
}

export function bankingErrorResponse(error: unknown): Response {
  const known = error instanceof BankingError;
  return Response.json({ error: known ? error.code : 'banking_unavailable' }, {
    status: known ? error.status : 503,
    headers: { 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache' },
  });
}
