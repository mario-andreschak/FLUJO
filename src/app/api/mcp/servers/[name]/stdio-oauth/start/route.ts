import { NextRequest } from "next/server";
import { assertUnlocked } from "@/utils/encryption/lockGate";
import { mcpService } from "@/backend/services/mcp";
import { createLogger } from "@/utils/logger";
import { json } from "../../../../_helpers";

const log = createLogger("app/api/mcp/servers/[name]/stdio-oauth/start/route");
type RouteContext = { params: Promise<{ name: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const locked = await assertUnlocked();
  if (locked) return locked;

  try {
    const { name } = await params;
    const body = (await request.json()) as { authorizationId?: unknown };
    if (
      typeof body.authorizationId !== "string" ||
      body.authorizationId.length === 0
    ) {
      return json({ error: "authorizationId is required." }, 400);
    }

    // The service reconnects when needed and immediately refreshes the
    // read-only status before start, so only an ID from that latest result can
    // reach the custom method. Keeping that check in one place avoids a
    // disconnect race between this route and the reconnecting service.
    const prompt = await mcpService.prepareExternalAuthorization(
      name,
      body.authorizationId,
      { signal: request.signal },
    );
    return json(prompt, 200);
  } catch (error) {
    log.warn("Failed to prepare stdio OAuth authorization", error);
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to prepare authorization.",
      },
      502,
    );
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const locked = await assertUnlocked();
  if (locked) return locked;

  const { name } = await params;
  let sessionId: string | undefined;
  let action: "cancel" | "decline" = "cancel";
  try {
    const body = (await request.json()) as {
      sessionId?: unknown;
      action?: unknown;
    };
    if (typeof body.sessionId === "string") sessionId = body.sessionId;
    if (body.action === "decline") action = "decline";
  } catch {
    // An empty body cancels the newest pending session for this server.
  }

  if (action === "decline") {
    if (!sessionId)
      return json({ error: "sessionId is required to decline." }, 400);
    return json(
      { declined: mcpService.declineExternalAuthorization(name, sessionId) },
      200,
    );
  }
  return json(
    { cancelled: mcpService.cancelExternalAuthorization(name, sessionId) },
    200,
  );
}
