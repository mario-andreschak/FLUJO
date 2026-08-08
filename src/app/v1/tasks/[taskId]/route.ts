import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { getTask, requestCancel, toTaskHandle } from '@/backend/services/subflowTasks';

function responseForTask(task: Awaited<ReturnType<typeof getTask>>) {
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  return NextResponse.json({
    task: toTaskHandle(task),
    ...(task.status === 'completed' ? {
      result: {
        outputText: task.outputText,
        outputMedia: task.outputMedia,
        outputResourceUris: task.outputResourceUris,
      },
    } : {}),
    ...(task.error ? { error: task.error } : {}),
  });
}

async function GET_handler(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  return responseForTask(await getTask((await params).taskId));
}

async function DELETE_handler(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  return responseForTask(await requestCancel((await params).taskId));
}

export const GET = withWorkspaceRoute(GET_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
