/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Server-side conversation session manager for multi-turn NLQ translation.
 *
 * Maintains conversation state so clients can send follow-up questions
 * (e.g., "now filter that by status=active") or corrections
 * (e.g., "no, I meant revenue not order count") without managing history themselves.
 *
 * Sessions auto-expire after a configurable TTL (default: 30 minutes).
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  ConversationSession,
  ConversationTurn,
  ConversationMessage,
  ConversationConfig,
  CubeQuery,
} from '../types';

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_PROMPT_HISTORY_SIZE = 6;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ConversationManager {
  private sessions: Map<string, ConversationSession> = new Map();
  private config: Required<ConversationConfig>;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: ConversationConfig) {
    this.config = {
      sessionTtlMs: config?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      maxTurns: config?.maxTurns ?? DEFAULT_MAX_TURNS,
      promptHistorySize: config?.promptHistorySize ?? DEFAULT_PROMPT_HISTORY_SIZE,
    };

    // Periodic cleanup of expired sessions
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Don't block process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Create a new conversation session.
   * Returns the conversation ID to be sent back to the client.
   */
  create(securityContext?: any): string {
    const conversationId = uuidv4();
    const now = new Date();
    this.sessions.set(conversationId, {
      conversationId,
      turns: [],
      securityContext,
      createdAt: now,
      lastActiveAt: now,
    });
    return conversationId;
  }

  /**
   * Get an existing session, or return null if expired/not found.
   */
  get(conversationId: string): ConversationSession | null {
    const session = this.sessions.get(conversationId);
    if (!session) return null;

    // Check TTL
    const age = Date.now() - session.lastActiveAt.getTime();
    if (age > this.config.sessionTtlMs) {
      this.sessions.delete(conversationId);
      return null;
    }

    return session;
  }

  /**
   * Record a completed turn in the conversation.
   * Called after each translation with the question and result.
   */
  addTurn(conversationId: string, nlq: string, query: CubeQuery | null, translationId: string): void {
    const session = this.get(conversationId);
    if (!session) return;

    session.turns.push({
      nlq,
      query,
      translationId,
      timestamp: new Date(),
    });

    // Trim to max turns (keep most recent)
    if (session.turns.length > this.config.maxTurns) {
      session.turns = session.turns.slice(-this.config.maxTurns);
    }

    session.lastActiveAt = new Date();
  }

  /**
   * Build conversation history for the LLM prompt from the session's turns.
   * Converts turns into ConversationMessage[] format suitable for the PromptBuilder.
   *
   * Includes the last N turns (configurable via promptHistorySize).
   * Each turn becomes a user message (the NLQ) and an assistant message (the query JSON).
   */
  buildHistory(conversationId: string): ConversationMessage[] {
    const session = this.get(conversationId);
    if (!session || session.turns.length === 0) return [];

    const recentTurns = session.turns.slice(-this.config.promptHistorySize);
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
  getLastQuery(conversationId: string): CubeQuery | null {
    const session = this.get(conversationId);
    if (!session) return null;

    // Walk backwards to find the last successful query
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
  delete(conversationId: string): void {
    this.sessions.delete(conversationId);
  }

  /**
   * Remove all expired sessions.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveAt.getTime() > this.config.sessionTtlMs) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Shut down the manager and stop the cleanup timer.
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }

  /**
   * Number of active sessions (for monitoring).
   */
  get activeSessionCount(): number {
    return this.sessions.size;
  }
}
