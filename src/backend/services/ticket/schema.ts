import { z } from 'zod';
import { PersonaAttributionSchema } from '@/shared/types/enduringAgent';

export const SAFE_TICKET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Trusted conversation provenance; intentionally absent from the caller input schema. */
export const TicketPersonaAttributionSchema = PersonaAttributionSchema;

export const CreateTicketInputSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  labels: z.union([z.string(), z.array(z.string())]).optional(),
  title: z.string().trim().max(120).optional(),
  conversationId: z.string().regex(SAFE_TICKET_ID_RE).optional(),
  messageId: z.string().regex(SAFE_TICKET_ID_RE).optional(),
  flowId: z.string().regex(SAFE_TICKET_ID_RE).optional(),
  nodeId: z.string().max(128).optional(),
  source: z.enum(['agent', 'host']).optional(),
});

export const TicketPatchSchema = z.object({
  status: z.enum(['open', 'done']).optional(),
  labels: z.union([z.string(), z.array(z.string())]).optional(),
  message: z.string().trim().min(1).max(4000).optional(),
  title: z.string().trim().max(120).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required.');
