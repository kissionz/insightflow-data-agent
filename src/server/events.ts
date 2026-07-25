import type { ServerResponse } from "node:http";
import type { DataAgentEvent } from "../shared/types.js";

export class EventHub {
  private readonly listeners = new Map<string, Set<ServerResponse>>();
  private sequence = 0;

  subscribe(conversationId: string, response: ServerResponse): () => void {
    const listeners = this.listeners.get(conversationId) ?? new Set<ServerResponse>();
    listeners.add(response);
    this.listeners.set(conversationId, listeners);
    return () => {
      listeners.delete(response);
      if (listeners.size === 0) this.listeners.delete(conversationId);
    };
  }

  publish(event: Omit<DataAgentEvent, "eventId" | "sequence" | "timestamp">): void {
    const completeEvent: DataAgentEvent = {
      ...event,
      eventId: `evt_${++this.sequence}`,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
    };
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(completeEvent)}\n\n`;
    for (const response of this.listeners.get(event.conversationId) ?? []) {
      response.write(payload);
    }
  }
}
