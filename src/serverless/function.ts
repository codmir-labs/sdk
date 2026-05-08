/**
 * @fileoverview
 * Codmir Function - Serverless function wrapper
 * 
 * Provides local/remote execution with Grace governance.
 */

import type { CodmirApp } from './app';
import type {
  FunctionConfig,
  ExecutionResult,
  CallOptions,
  StreamEvent,
  BatchConfig,
  BatchResult,
  ExecutionPool,
} from './types';
import { execute, executeAsync, executeLocal } from './execution';

/**
 * Codmir Function - Serverless function with hybrid execution.
 * 
 * @example
 * ```typescript
 * const fn = app.function({ cpu: 2 })(async (x: number) => x * 2);
 * 
 * // Local execution (for development)
 * const localResult = await fn.local(5);
 * 
 * // Remote execution (cloud)
 * const remoteResult = await fn.remote(5);
 * 
 * // Auto-select based on environment
 * const result = await fn(5);
 * ```
 */
export class CodmirFunction<TArgs extends unknown[], TReturn> {
  readonly name: string;
  readonly config: FunctionConfig;
  
  private app: CodmirApp;
  private handler: (...args: TArgs) => Promise<TReturn>;
  private executionCount = 0;

  constructor(
    app: CodmirApp,
    config: FunctionConfig,
    handler: (...args: TArgs) => Promise<TReturn>
  ) {
    this.app = app;
    this.config = config;
    this.handler = handler;
    this.name = config.name || this.generateName();
  }

  private generateName(): string {
    return `${this.app.name}_fn_${Date.now().toString(36)}`;
  }

  /**
   * Execute the function (auto-selects local/remote based on environment).
   */
  async call(...args: TArgs): Promise<TReturn> {
    if (this.shouldRunLocally()) {
      return this.local(...args);
    }
    return this.remote(...args);
  }

  /**
   * Execute locally (for development).
   */
  async local(...args: TArgs): Promise<TReturn> {
    const startTime = Date.now();
    this.executionCount++;

    try {
      const result = await executeLocal(this.handler, args);
      
      console.log(`[codmir] ${this.name} completed locally in ${Date.now() - startTime}ms`);
      return result;
    } catch (error) {
      console.error(`[codmir] ${this.name} failed locally:`, error);
      throw error;
    }
  }

  /**
   * Execute remotely in the cloud.
   */
  async remote(...args: TArgs): Promise<TReturn> {
    const result = await execute<TArgs, TReturn>({
      appName: this.app.name,
      functionName: this.name,
      args,
      config: this.config,
      grace: this.config.grace,
    });

    if (result.status === 'completed' && result.result !== undefined) {
      return result.result;
    }

    if (result.status === 'failed') {
      throw new Error(result.error || 'Remote execution failed');
    }

    throw new Error(`Unexpected execution status: ${result.status}`);
  }

  /**
   * Execute asynchronously and return execution ID.
   */
  async spawn(...args: TArgs): Promise<string> {
    const executionId = await executeAsync<TArgs>({
      appName: this.app.name,
      functionName: this.name,
      args,
      config: this.config,
      grace: this.config.grace,
    });

    return executionId;
  }

  /**
   * Execute with streaming results.
   */
  async *stream(...args: TArgs): AsyncGenerator<StreamEvent> {
    const executionId = await this.spawn(...args);

    yield { type: 'started', executionId };

    // In production, this would poll/subscribe to execution updates
    // For now, simulate the stream
    yield { type: 'progress', percent: 0, message: 'Starting...' };

    try {
      const result = await this.remote(...args);
      yield { type: 'progress', percent: 100, message: 'Completed' };
      yield { type: 'completed', result };
    } catch (error) {
      yield { type: 'failed', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute in batch with multiple inputs.
   */
  async map<T extends TArgs[0]>(
    inputs: T[],
    config: BatchConfig = {}
  ): Promise<BatchResult<TReturn>> {
    const { maxConcurrency = 10, continueOnError = true } = config;
    
    const successful: Array<{ index: number; result: TReturn }> = [];
    const failed: Array<{ index: number; error: string }> = [];
    const startTime = Date.now();
    let totalCredits = 0;

    // Process in batches
    for (let i = 0; i < inputs.length; i += maxConcurrency) {
      const batch = inputs.slice(i, i + maxConcurrency);
      const promises = batch.map(async (input, batchIndex) => {
        const index = i + batchIndex;
        try {
          const result = await this.call(...[input] as unknown as TArgs) as TReturn;
          successful.push({ index, result });
        } catch (error) {
          if (!continueOnError) throw error;
          failed.push({ 
            index, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      });

      await Promise.all(promises);
      
      if (config.onProgress) {
        config.onProgress(successful.length + failed.length, inputs.length);
      }
    }

    return {
      total: inputs.length,
      successful,
      failed,
      metrics: {
        totalDurationMs: Date.now() - startTime,
        totalCreditsUsed: totalCredits,
        totalCarbonFootprint: 0, // Would be calculated from execution metrics
      },
    };
  }

  /**
   * Execute with specific options.
   */
  async withOptions(options: CallOptions, ...args: TArgs): Promise<TReturn> {
    const mergedConfig = {
      ...this.config,
      timeout: options.timeout ?? this.config.timeout,
      pool: options.pool ?? this.config.pool,
      grace: { ...this.config.grace, ...options.grace },
    };

    const result = await execute<TArgs, TReturn>({
      appName: this.app.name,
      functionName: this.name,
      args,
      config: mergedConfig,
      grace: mergedConfig.grace,
      wait: options.wait ?? true,
      callbackUrl: options.callbackUrl,
    });

    if (result.status === 'completed' && result.result !== undefined) {
      return result.result;
    }

    throw new Error(result.error || `Execution ${result.status}`);
  }

  /**
   * Get execution status by ID.
   */
  async getStatus(executionId: string): Promise<ExecutionResult<TReturn>> {
    // In production, this would call the Codmir API
    return {
      id: executionId,
      status: 'pending',
      metrics: {
        durationMs: 0,
        creditsUsed: 0,
        pool: 'auto',
      },
    };
  }

  /**
   * Cancel an execution.
   */
  async cancel(executionId: string): Promise<void> {
    console.log(`[codmir] Cancelling execution: ${executionId}`);
    // In production, this would call the Codmir API
  }

  /**
   * Check if function should run locally.
   */
  private shouldRunLocally(): boolean {
    // Run locally in development or when explicitly configured
    const env = process.env.NODE_ENV || 'development';
    const forceRemote = process.env.CODMIR_FORCE_REMOTE === 'true';
    const forceLocal = process.env.CODMIR_FORCE_LOCAL === 'true';

    if (forceRemote) return false;
    if (forceLocal) return true;
    if (env === 'development') return true;
    
    return false;
  }

  /**
   * Make the function callable directly.
   */
  [Symbol.for('nodejs.util.promisify.custom')](...args: TArgs): Promise<TReturn> {
    return this.call(...args);
  }
}

/**
 * Create a Codmir function.
 */
export function createFunction<TArgs extends unknown[], TReturn>(
  app: CodmirApp,
  config: FunctionConfig,
  handler: (...args: TArgs) => Promise<TReturn>
): CodmirFunction<TArgs, TReturn> {
  return new CodmirFunction(app, config, handler);
}
