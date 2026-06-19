/**
 * Shared helpers for the Flow REST routes.
 *
 * This file is intentionally NOT named `route.ts`, so Next.js treats it as a plain
 * module rather than a route handler.
 */

/**
 * Build a JSON Response with the given status code.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
