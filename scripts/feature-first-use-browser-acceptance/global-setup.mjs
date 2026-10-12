import { promises as fs } from 'node:fs';
import path from 'node:path';
import { admitFeatureBrowserArtifact } from './artifact-admission.mjs';

export default async function globalSetup() {
  const admitted = await admitFeatureBrowserArtifact(process.env.FEATURE_BROWSER_APP_DIR);
  const output = process.env.FEATURE_BROWSER_OUTPUT_DIR;
  if (!output || !path.isAbsolute(output)) throw new Error('Set an owned absolute FEATURE_BROWSER_OUTPUT_DIR.');
  await fs.writeFile(path.join(output, 'artifact-admission-start.json'), JSON.stringify(admitted, null, 2), { flag: 'wx' });
  return async () => {
    const after = await admitFeatureBrowserArtifact(process.env.FEATURE_BROWSER_APP_DIR);
    await fs.writeFile(path.join(output, 'artifact-admission-final.json'), JSON.stringify(after, null, 2), { flag: 'wx' });
  };
}
