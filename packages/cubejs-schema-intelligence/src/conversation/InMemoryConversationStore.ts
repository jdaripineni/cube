/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview In-memory conversation store — fast, zero-dependency, single-pod only.
 *
 * Sessions are stored in a `Map` and lost on process restart.
 * Not shared across pods. Suitable for dev/test or single-pod deployments.
 * For production multi-pod setups, use {@link RedisConversationStore}.
 */

import type {
  ConversationStore,
  ConversationSession,
  ConversationConfig,
} from '../types';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class InMemoryConversationStore implements ConversationStore {
  private sessions: Map<string, ConversationSession> = new Map();
  private ttlMs: number;
  private maxTurns: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: ConversationConfig) {
    this.ttlMs = config?.sessionTtlMs ?? DEFAULT_TTL_MS;
    this.maxTurns = config?.maxTurns ?? 20;

    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  async get(conversationId: string): Promise<ConversationSession | null> {
    const session = this.sessions.get(conversationId);
    if (!session) return null;

    const age = Date.now() - session.lastActiveAt.getTime();
    if (age > this.ttlMs) {
      this.sessions.delete(conversationId);
      return null;
    }

    return session;
  }

  async save(session: ConversationSession): Promise<void> {
    // Enforce max turns
    if (session.turns.length > this.maxTurns) {
      session.turns = session.turns.slice(-this.maxTurns);
    }
    this.sessions.set(session.conversationId, session);
  }

  async delete(conversationId: string): Promise<void> {
    this.sessions.delete(conversationId);
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveAt.getTime() > this.ttlMs) {
        this.sessions.delete(id);
      }
    }
  }
}
