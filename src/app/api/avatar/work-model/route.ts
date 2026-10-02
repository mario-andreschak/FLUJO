import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { modelService } from '@/backend/services/model';
import { selectVerifiedAvatarWorkModel } from '@/backend/services/avatar/workModel';

export const runtime = 'nodejs';

export const POST = withWorkspaceRoute(async (request: Request) => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const body = await request.json().catch(() => null);
  if (typeof body?.modelId !== 'string' || !body.modelId || body.modelId.length > 256) {
    return Response.json({ error: 'Choose a saved model.' }, { status: 400 });
  }
  const model = await modelService.getModel(body.modelId);
  if (!model) return Response.json({ error: 'Model no longer exists.' }, { status: 404 });
  if (model.supportsTools === false) return Response.json({ error: 'Choose a model that supports tools.' }, { status: 400 });
  const test = await modelService.testModel({ modelId: model.id });
  if (test.ok && test.tool?.ok) {
    // Re-read: a concurrent edit must never inherit a different configuration's test.
    const current = await modelService.getModel(model.id);
    if (JSON.stringify(current) !== JSON.stringify(model)) {
      return Response.json({ error: 'The connection changed during verification. Test it again.' }, { status: 409 });
    }
    await selectVerifiedAvatarWorkModel(model);
    return Response.json({ ready: true, test });
  }
  return Response.json({ ready: false, test });
});
