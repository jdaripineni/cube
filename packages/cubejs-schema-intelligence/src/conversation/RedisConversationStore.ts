/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Redis-backed conversation store — persistent, shared across pods.
 *
 * Sessions are stored as JSON in Redis with native TTL (`SETEX`).
 * Any CubeJS pod can resume a conversation started on another pod.
 *
 * Requires `ioredis` as a peer dependency:
 * ```bash
 * npm install ioredis
 * ```
 *
 * @example
 * ```ts
 * const store = new RedisConversationStore({
 *   sessionTtlMs: 30 * 60 * 1000,
 *   maxTurns: 20,
 *   connectionOptions: { url: 'redis://redis:6379' },
 * });
 * ```
 */

import type {
  ConversationStore,
  ConversationSession,
  ConversationConfig,
} from '../types';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_KEY_PREFIX = 'cube:conv:';

export class RedisConversationStore implements ConversationStore {
  private client: any = null;
  private ttlMs: number;
  private ttlSec: number;
  private maxTurns: number;
  private keyPrefix: string;
  private connectionOptions: Record<string, any>;
  private initialized = false;

  constructor(config?: ConversationConfig) {
    this.ttlMs = config?.sessionTtlMs ?? DEFAULT_TTL_MS;
    this.ttlSec = Math.ceil(this.ttlMs / 1000);
    this.maxTurns = config?.maxTurns ?? 20;
    this.connectionOptions = config?.connectionOptions ?? {};
    this.keyPrefix = this.connectionOptions.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  private async ensureConnected(): Promise<void> {
    if (this.initialized) return;

    let Redis: any;
    try {
      Redis = (await import('ioredis')).default;
    } catch {
      throw new Error(
        'Redis conversation store requires ioredis. Install it: npm install ioredis'
      );
    }

    if (this.connectionOptions.url) {
      this.client = new Redis(this.connectionOptions.url, {
        ...this.connectionOptions,
        lazyConnect: true,
      });
    } else {
      this.client = new Redis({
        ...this.connectionOptions,
        lazyConnect: true,
      });
    }

    await this.client.connect();
    this.initialized = true;
  }

  private key(conversationId: string): string {
    return `${this.keyPrefix}${conversationId}`;
  }

  async get(conversationId: string): Promise<ConversationSession | null> {
    await this.ensureConnected();

    const raw = await this.client.get(this.key(conversationId));
    if (!raw) return null;

    try {
      const session = JSON.parse(raw) as ConversationSession;
      // Rehydrate Date objects from JSON strings
      session.createdAt = new Date(session.createdAt);
      session.lastActiveAt = new Date(session.lastActiveAt);
      for (const turn of session.turns) {
        turn.timestamp = new Date(turn.timestamp);
      }
      return session;
    } catch {
      // Corrupted data — delete and return null
      await this.client.del(this.key(conversationId));
      return null;
    }
  }

  async save(session: ConversationSession): Promise<void> {
    await this.ensureConnected();

    // Enforce max turns
    if (session.turns.length > this.maxTurns) {
      session.turns = session.turns.slice(-this.maxTurns);
    }

    const json = JSON.stringify(session);
    // SETEX: set with TTL in seconds — Redis handles expiry automatically
    await this.client.setex(this.key(session.conversationId), this.ttlSec, json);
  }

  async delete(conversationId: string): Promise<void> {
    await this.ensureConnected();
    await this.client.del(this.key(conversationId));
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.initialized = false;
    }
  }
}
