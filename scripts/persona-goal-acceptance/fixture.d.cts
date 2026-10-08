interface Facts { product: string; sourceId: string; audience: string; benefit: string; channel: string; nonce: string }
interface Result { content: Array<{ type: string; text: string }>; isError?: boolean }
interface Audit { at: number; name: string; argumentsHash: string; result: Result }
interface Publication { id: string; sourceId: string; sha256: string; content: string; publishedAt: number }
interface Evidence { facts: Facts; artifacts: Array<{ name: string; sha256: string; verified: boolean; content: string }>; publicationVerified: boolean; published: Publication | null; transientFailureObserved: boolean; environmentBootstrapVerified: boolean; publishAttempts: number; audit: Audit[] }
declare const fixture: {
  createFixture(directory: string, retryDelayMs?: number): Promise<Facts>;
  readFixture(directory: string): Promise<{ facts: Facts; retryDelayMs: number; publishAttempts: number; retryAfter: number | null; published: Publication | null }>;
  readArtifacts(directory: string): Promise<Record<string, string>>;
  verifyFixture(directory: string): Promise<Evidence>;
  callFixtureTool(directory: string, name: string, args?: Record<string, unknown>): Promise<Result>;
};
export = fixture;
