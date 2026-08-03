import { NextRequest } from "next/server";
import { assertUnlocked } from "@/utils/encryption/lockGate";
import { mcpService } from "@/backend/services/mcp";
import { createLogger } from "@/utils/logger";
import { json } from "../../../../_helpers";

const log = createLogger(
  "app/api/mcp/servers/[name]/stdio-oauth/confirm/route",
);
type RouteContext = { params: Promise<{ name: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const locked = await assertUnlocked();
  if (locked) return locked;

  try {
    const { name } = await params;
    const body = (await request.json()) as { sessionId?: unknown };
    if (typeof body.sessionId !== "string" || !body.sessionId) {
      return json({ error: "sessionId is required." }, 400);
    }

    // Return the backend-stored URL after accepting the elicitation; do not
    // trust a URL echoed back from the browser.
    const prompt = mcpService.confirmExternalAuthorization(
      name,
      body.sessionId,
    );
    return json(prompt, 200);
  } catch (error) {
    log.warn("Failed to confirm stdio OAuth authorization", error);
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to confirm authorization.",
      },
      409,
    );
  }
}
