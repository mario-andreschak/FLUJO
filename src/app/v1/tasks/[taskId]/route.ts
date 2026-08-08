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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  return responseForTask(await getTask((await params).taskId));
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  return responseForTask(await requestCancel((await params).taskId));
}
