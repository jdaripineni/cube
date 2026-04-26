/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Retry-with-backoff wrapper for fetch(), used by Ollama providers.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Initial delay in ms before the first retry (default: 1000). */
  initialDelayMs?: number;
  /** Multiplier applied to delay after each retry (default: 2). */
  backoffMultiplier?: number;
  /** Maximum delay cap in ms (default: 10000). */
  maxDelayMs?: number;
  /** Per-request timeout in ms (default: 60000). */
  timeoutMs?: number;
}

const DEFAULTS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 10_000,
  timeoutMs: 60_000,
};

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Network-level failures that are worth retrying
    return msg.includes('fetch failed') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('aborted');
  }
  return false;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Execute a fetch request with retry + exponential backoff.
 * Only retries on transient network errors and 429/502/503/504 status codes.
 */
export async function retryFetch(
  input: string | URL,
  init?: RequestInit,
  opts?: RetryOptions,
): Promise<Response> {
  const { maxRetries, initialDelayMs, backoffMultiplier, maxDelayMs, timeoutMs } = {
    ...DEFAULTS,
    ...opts,
  };

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const mergedInit: RequestInit = {
        ...init,
        signal: controller.signal,
      };

      const resp = await fetch(input, mergedInit);
      clearTimeout(timer);

      if (resp.ok || !isRetryableStatus(resp.status)) {
        return resp;
      }

      // Retryable HTTP status — treat as transient
      lastError = new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isRetryable(lastError) && attempt === 0) {
        // Non-retryable error on first attempt — fail fast
        throw lastError;
      }
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError || new Error('retryFetch: all retries exhausted');
}
