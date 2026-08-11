"use client";

import type {
  CreateMeetingInput,
  MeetingEvent,
  MeetingRecord,
  MeetingSummary,
} from '@/shared/types/meeting';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/services/meetings');
const BASE = '/v1/meetings';

export interface MeetingDetailResponse {
  meeting: MeetingRecord;
  events: MeetingEvent[];
}

export interface MeetingStreamHandlers {
  onEvent: (event: MeetingEvent) => void;
  onOpen?: () => void;
  onError?: (event: Event) => void;
}

async function parse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data
      ? String(data.error)
      : `Meeting request failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

class MeetingsService {
  async list(): Promise<MeetingSummary[]> {
    return parse<MeetingSummary[]>(await fetch(withWorkspaceUrl(BASE)));
  }

  async create(input: CreateMeetingInput): Promise<MeetingRecord> {
    return parse<MeetingRecord>(await fetch(withWorkspaceUrl(BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }));
  }

  async get(id: string): Promise<MeetingDetailResponse> {
    return parse<MeetingDetailResponse>(await fetch(withWorkspaceUrl(`${BASE}/${encodeURIComponent(id)}`)));
  }

  async start(id: string): Promise<MeetingRecord> {
    const result = await parse<{ meeting: MeetingRecord }>(await fetch(
      withWorkspaceUrl(`${BASE}/${encodeURIComponent(id)}/start`),
      { method: 'POST' },
    ));
    return result.meeting;
  }

  async cancel(id: string): Promise<MeetingRecord> {
    const result = await parse<{ meeting: MeetingRecord }>(await fetch(
      withWorkspaceUrl(`${BASE}/${encodeURIComponent(id)}/cancel`),
      { method: 'POST' },
    ));
    return result.meeting;
  }

  async addPrivateNote(id: string, content: string): Promise<MeetingEvent> {
    const result = await parse<{ event: MeetingEvent }>(await fetch(
      withWorkspaceUrl(`${BASE}/${encodeURIComponent(id)}/private-notes`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      },
    ));
    return result.event;
  }

  async steer(id: string, content: string): Promise<MeetingEvent> {
    const result = await parse<{ event: MeetingEvent }>(await fetch(
      withWorkspaceUrl(`${BASE}/${encodeURIComponent(id)}/interventions`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      },
    ));
    return result.event;
  }

  subscribe(
    id: string,
    handlers: MeetingStreamHandlers,
    fromSeq?: number,
  ): EventSource {
    const suffix = fromSeq === undefined ? '' : `?fromSeq=${encodeURIComponent(fromSeq)}`;
    const source = new EventSource(withWorkspaceUrl(
      `${BASE}/${encodeURIComponent(id)}/events${suffix}`,
    ));

    source.onopen = () => handlers.onOpen?.();
    source.onmessage = (message) => {
      try {
        handlers.onEvent(JSON.parse(message.data) as MeetingEvent);
      } catch (error) {
        log.warn('Could not parse meeting event', { id, error });
      }
    };
    source.onerror = (event) => handlers.onError?.(event);
    return source;
  }
}

export const meetingsService = new MeetingsService();
