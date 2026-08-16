import fs from 'fs';
import path from 'path';

describe('models page workspace bootstrap', () => {
  it('does not seed the client from a default-only server adapter read', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/models/page.tsx'), 'utf8');
    const client = fs.readFileSync(path.join(process.cwd(), 'src/app/models/ModelClient.tsx'), 'utf8');
    expect(page).not.toContain('backend-model-adapter');
    expect(page).toContain('<ModelClient />');
    expect(client).toContain('getModelService().loadModels()');
  });
});
