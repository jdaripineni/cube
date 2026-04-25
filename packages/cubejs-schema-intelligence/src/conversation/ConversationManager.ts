/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Server-side conversation session manager for multi-turn NLQ translation.
 *
 * Delegates persistence to a pluggable {@link ConversationStore} backend:
 * - `InMemoryConversationStore` (default) — fast, single-pod, lost on restart
 * - `RedisConversationStore` — shared across pods, survives restarts
 * - Any custom implementation of the `ConversationStore` interface
 *
 * The manager handles session lifecycle (create, add turn, build history)
 * while the store handles persistence and TTL enforcement.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  ConversationStore,
  ConversationSession,
  ConversationMessage,
  ConversationConfig,
  CubeQuery,
} from '../types';

const DEFAULT_PROMPT_HISTORY_SIZE = 6;

export class ConversationManager {
  private store: ConversationStore;
  private promptHistorySize: number;
  private maxTurns: number;

  constructor(store: ConversationStore, config?: ConversationConfig) {
    this.store = store;
    this.promptHistorySize = config?.promptHistorySize ?? DEFAULT_PROMPT_HISTORY_SIZE;
    this.maxTurns = config?.maxTurns ?? 20;
  }

  /**
   * Create a new conversation session.
   * Returns the conversation ID to be sent back to the client.
   */
  async create(securityContext?: any): Promise<string> {
    const conversationId = uuidv4();
    const now = new Date();
    const session: ConversationSession = {
      conversationId,
      turns: [],
      securityContext,
      createdAt: now,
      lastActiveAt: now,
    };
    await this.store.save(session);
    return conversationId;
  }

  /**
   * Get an existing session, or return null if expired/not found.
   */
  async get(conversationId: string): Promise<ConversationSession | null> {
    return this.store.get(conversationId);
  }

  /**
   * Record a completed turn in the conversation.
   * Called after each translation with the question and result.
   */
  async addTurn(conversationId: string, nlq: string, query: CubeQuery | null, translationId: string): Promise<void> {
    const session = await this.store.get(conversationId);
    if (!session) return;

    session.turns.push({
      nlq,
      query,
      translationId,
      timestamp: new Date(),
    });

    // Trim to max turns (keep most recent)
    if (session.turns.length > this.maxTurns) {
      session.turns = session.turns.slice(-this.maxTurns);
    }

    session.lastActiveAt = new Date();
    await this.store.save(session);
  }

  /**
   * Build conversation history for the LLM prompt from the session's turns.
   * Converts turns into ConversationMessage[] format suitable for the PromptBuilder.
   *
   * Includes the last N turns (configurable via promptHistorySize).
   * Each turn becomes a user message (the NLQ) and an assistant message (the query JSON).
   */
  async buildHistory(conversationId: string): Promise<ConversationMessage[]> {
    const session = await this.store.get(conversationId);
    if (!session || session.turns.length === 0) return [];

    const recentTurns = session.turns.slice(-this.promptHistorySize);
    const messages: ConversationMessage[] = [];

    for (const turn of recentTurns) {
      messages.push({ role: 'user', content: turn.nlq });
      if (turn.query) {
        messages.push({ role: 'assistant', content: JSON.stringify(turn.query) });
      } else {
        messages.push({ role: 'assistant', content: '(translation failed)' });
      }
    }

    return messages;
  }

  /**
   * Get the last successful query from a conversation.
   * Useful for corrections — the LLM needs to know what "that" refers to.
   */
  async getLastQuery(conversationId: string): Promise<CubeQuery | null> {
    const session = await this.store.get(conversationId);
    if (!session) return null;

    for (let i = session.turns.length - 1; i >= 0; i--) {
      if (session.turns[i].query) {
        return session.turns[i].query;
      }
    }
    return null;
  }

  /**
   * Delete a conversation session.
   */
  async delete(conversationId: string): Promise<void> {
    await this.store.delete(conversationId);
  }

  /**
   * Shut down the manager and its backing store.
   */
  async shutdown(): Promise<void> {
    await this.store.shutdown();
  }
}
