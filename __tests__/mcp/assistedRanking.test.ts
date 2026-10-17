import { scoreMcpAssistantCandidate } from '@/backend/services/mcp/assistedInstall';

const base = {
  qualityScore: 0.7,
  relevance: 1,
  verified: true,
  awesomeMention: false,
  transport: 'remote' as const,
  requiredInputCount: 0,
};

describe('MCP assisted recommendation ranking', () => {
  it.each(['oauth-cimd', 'oauth-dcr'] as const)('prefers %s over manual OAuth when other evidence is equal', authMode => {
    const dcr = scoreMcpAssistantCandidate({ ...base, authMode });
    const manual = scoreMcpAssistantCandidate({ ...base, authMode: 'oauth-manual' });

    expect(dcr).toBeGreaterThan(manual);
  });

  it('rewards popular local packages and penalizes credential friction', () => {
    const popular = scoreMcpAssistantCandidate({
      ...base,
      transport: 'package',
      weeklyDownloads: 50_000,
      requiredInputCount: 0,
    });
    const obscureAndKeyed = scoreMcpAssistantCandidate({
      ...base,
      transport: 'package',
      weeklyDownloads: 20,
      requiredInputCount: 3,
    });

    expect(popular).toBeGreaterThan(obscureAndKeyed);
  });
});
