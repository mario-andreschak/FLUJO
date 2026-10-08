import type { z } from 'zod';
import { buildOwnedArchiveSchema, buildOwnedToolInputShape } from './ownedArchiveSchema';

type JsonSchema = Record<string, unknown>;

/** Data-only, metered replacement for the existing represented conversion. */
export function jsonSchemaNodeToZod(node: unknown): z.ZodType {
  return buildOwnedArchiveSchema(node);
}

export interface ToolInputShape {
  shape: Record<string, z.ZodType>;
  fallbackSchema?: JsonSchema;
}

/** Existing public constructors also carry exact owned archive descriptors. */
export function buildToolInputShape(schema: unknown): ToolInputShape {
  return buildOwnedToolInputShape(schema);
}

export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodType> {
  return buildToolInputShape(schema).shape;
}

/** Preserve the original fallback description rendering and provider contract. */
export function embedSchemaInDescription(description: string, fallbackSchema: JsonSchema | undefined): string {
  if (!fallbackSchema) return description;
  const json = JSON.stringify(fallbackSchema);
  const note =
    `The parameters follow this JSON Schema (a composed/conditional schema that ` +
    `cannot be fully expressed as simple parameters) — follow it exactly:\n${json}`;
  return description ? `${description}\n\n${note}` : note;
}