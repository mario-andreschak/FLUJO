/** SDK consumption attribution is distinct from durable mailbox send acceptance. */
export class ClaudeResultCorrelation {
  private pending = new Set<string>();
  private results = new Set<string>();
  private lastIndex?: number;

  submitted(uuid: string): void { this.pending.add(uuid); }

  result(message: { uuid?: string; result_index?: number; user_message_uuid?: string;
    user_message_uuids?: string[]; queued_turn_count?: number }): { duplicate: boolean; settled: boolean } {
    if ((message.uuid && this.results.has(message.uuid)) || (message.result_index !== undefined
      && this.lastIndex !== undefined && message.result_index <= this.lastIndex)) {
      return { duplicate: true, settled: false };
    }
    if (message.uuid) this.results.add(message.uuid);
    if (message.result_index !== undefined) this.lastIndex = message.result_index;
    const consumed = message.user_message_uuids?.length ? message.user_message_uuids
      : message.user_message_uuid ? [message.user_message_uuid] : undefined;
    if (consumed) for (const uuid of consumed) this.pending.delete(uuid);
    else {
      // Older producers lack attribution. Only the oldest submitted send can
      // be inferred; unknown background results must never consume a newer send.
      const oldest = this.pending.values().next().value;
      if (oldest) this.pending.delete(oldest);
    }
    return { duplicate: false, settled: this.pending.size === 0 && !(message.queued_turn_count && message.queued_turn_count > 0) };
  }

  get pendingCount(): number { return this.pending.size; }
}
