/**
 * @license Apache-2.0
 * @copyright Cube Dev, Inc.
 * @fileoverview Local embedding provider using @xenova/transformers (ONNX runtime).
 * Zero external API dependencies — runs entirely in Node.js.
 */

import type { EmbeddingProvider } from '../types';

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private pipeline: any;
  private modelName: string;
  private dimCount: number;

  constructor(model?: string) {
    this.modelName = model || 'Xenova/all-MiniLM-L6-v2';
    this.dimCount = 384;
    this.pipeline = null;
  }

  private async ensurePipeline(): Promise<any> {
    if (this.pipeline) return this.pipeline;

    let transformers: any;
    try {
      // @ts-ignore — optional peer dependency
      transformers = await import(/* webpackIgnore: true */ '@xenova/transformers');
    } catch {
      throw new Error(
        'Local embedding requires @xenova/transformers. Install it: npm install @xenova/transformers'
      );
    }

    this.pipeline = await transformers.pipeline('feature-extraction', this.modelName);
    return this.pipeline;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.ensurePipeline();
    const results: number[][] = [];

    for (const text of texts) {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(Array.from(output.data as Float32Array).slice(0, this.dimCount));
    }

    return results;
  }

  dimensions(): number {
    return this.dimCount;
  }

  async shutdown(): Promise<void> {
    this.pipeline = null;
  }
}
