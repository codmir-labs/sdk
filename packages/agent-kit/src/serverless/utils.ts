/**
 * @fileoverview
 * Codmir Utilities - Helpers for serverless functions
 * 
 * Provides logging, progress tracking, and checkpointing.
 */

/**
 * Log levels for structured logging.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log entry structure.
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Progress update structure.
 */
export interface ProgressUpdate {
  percent: number;
  message?: string;
  step?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Checkpoint data structure.
 */
export interface CheckpointData<T = unknown> {
  id: string;
  name?: string;
  data: T;
  timestamp: string;
}

/**
 * Execution context available within functions.
 */
export interface ExecutionContext {
  executionId: string;
  functionName: string;
  appName: string;
  startTime: string;
  timeout: number;
  remainingTimeMs: number;
}

// Global context for the current execution
let currentContext: ExecutionContext | null = null;

/**
 * Set the current execution context (called by runtime).
 */
export function setContext(ctx: ExecutionContext): void {
  currentContext = ctx;
}

/**
 * Get the current execution context.
 */
export function getContext(): ExecutionContext | null {
  return currentContext;
}

/**
 * Structured logging for serverless functions.
 * 
 * @example
 * ```typescript
 * import { logs } from '@codmir/sdk/serverless';
 * 
 * const fn = app.function()(async (data) => {
 *   logs.info('Processing started', { itemCount: data.length });
 *   
 *   try {
 *     const result = await process(data);
 *     logs.info('Processing completed', { resultCount: result.length });
 *     return result;
 *   } catch (error) {
 *     logs.error('Processing failed', { error: error.message });
 *     throw error;
 *   }
 * });
 * ```
 */
export const logs = {
  /**
   * Log a debug message.
   */
  debug(message: string, metadata?: Record<string, unknown>): void {
    logWithLevel('debug', message, metadata);
  },

  /**
   * Log an info message.
   */
  info(message: string, metadata?: Record<string, unknown>): void {
    logWithLevel('info', message, metadata);
  },

  /**
   * Log a warning message.
   */
  warn(message: string, metadata?: Record<string, unknown>): void {
    logWithLevel('warn', message, metadata);
  },

  /**
   * Log an error message.
   */
  error(message: string, metadata?: Record<string, unknown>): void {
    logWithLevel('error', message, metadata);
  },

  /**
   * Log with custom level.
   */
  log(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    logWithLevel(level, message, metadata);
  },
};

function logWithLevel(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    metadata,
  };

  // In production, this would send to the logging service
  const prefix = `[codmir:${level.toUpperCase()}]`;
  const metaStr = metadata ? ` ${JSON.stringify(metadata)}` : '';
  
  switch (level) {
    case 'debug':
      console.debug(`${prefix} ${message}${metaStr}`);
      break;
    case 'info':
      console.log(`${prefix} ${message}${metaStr}`);
      break;
    case 'warn':
      console.warn(`${prefix} ${message}${metaStr}`);
      break;
    case 'error':
      console.error(`${prefix} ${message}${metaStr}`);
      break;
  }
}

/**
 * Progress tracking for long-running functions.
 * 
 * @example
 * ```typescript
 * import { progress } from '@codmir/sdk/serverless';
 * 
 * const fn = app.function()(async (items) => {
 *   progress.start(items.length);
 *   
 *   const results = [];
 *   for (let i = 0; i < items.length; i++) {
 *     results.push(await processItem(items[i]));
 *     progress.update(i + 1, `Processing item ${i + 1}`);
 *   }
 *   
 *   progress.complete();
 *   return results;
 * });
 * ```
 */
export const progress = {
  _total: 0,
  _current: 0,

  /**
   * Start progress tracking.
   */
  start(total: number, message?: string): void {
    this._total = total;
    this._current = 0;
    this.report({ percent: 0, message: message || 'Starting...' });
  },

  /**
   * Update progress.
   */
  update(current: number, message?: string): void {
    this._current = current;
    const percent = this._total > 0 ? Math.round((current / this._total) * 100) : 0;
    this.report({ percent, message });
  },

  /**
   * Increment progress by one.
   */
  increment(message?: string): void {
    this.update(this._current + 1, message);
  },

  /**
   * Mark progress as complete.
   */
  complete(message?: string): void {
    this.report({ percent: 100, message: message || 'Completed' });
  },

  /**
   * Report progress update.
   */
  report(update: ProgressUpdate): void {
    // In production, this would send to the progress service
    console.log(`[codmir:PROGRESS] ${update.percent}% - ${update.message || ''}`);
  },

  /**
   * Get current progress percentage.
   */
  getPercent(): number {
    return this._total > 0 ? Math.round((this._current / this._total) * 100) : 0;
  },
};

/**
 * Checkpointing for resumable long-running functions.
 * 
 * @example
 * ```typescript
 * import { checkpoint } from '@codmir/sdk/serverless';
 * 
 * const fn = app.function({ checkpoints: true })(async (items) => {
 *   // Try to restore from checkpoint
 *   const state = await checkpoint.restore<{ processed: number; results: any[] }>();
 *   let { processed = 0, results = [] } = state?.data || {};
 *   
 *   for (let i = processed; i < items.length; i++) {
 *     results.push(await processItem(items[i]));
 *     
 *     // Save checkpoint every 100 items
 *     if ((i + 1) % 100 === 0) {
 *       await checkpoint.save({ processed: i + 1, results });
 *     }
 *   }
 *   
 *   await checkpoint.clear();
 *   return results;
 * });
 * ```
 */
export const checkpoint = {
  _data: null as CheckpointData | null,

  /**
   * Save a checkpoint.
   */
  async save<T>(data: T, name?: string): Promise<string> {
    const id = `cp_${Date.now().toString(36)}`;
    const cp: CheckpointData<T> = {
      id,
      name,
      data,
      timestamp: new Date().toISOString(),
    };

    this._data = cp as CheckpointData;
    
    // In production, this would persist to storage
    console.log(`[codmir:CHECKPOINT] Saved: ${id}${name ? ` (${name})` : ''}`);
    
    return id;
  },

  /**
   * Restore from the latest checkpoint.
   */
  async restore<T>(): Promise<CheckpointData<T> | null> {
    // In production, this would load from storage
    return this._data as CheckpointData<T> | null;
  },

  /**
   * Restore from a specific checkpoint.
   */
  async restoreById<T>(id: string): Promise<CheckpointData<T> | null> {
    // In production, this would load from storage
    if (this._data?.id === id) {
      return this._data as CheckpointData<T>;
    }
    return null;
  },

  /**
   * List available checkpoints.
   */
  async list(): Promise<Array<{ id: string; name?: string; timestamp: string }>> {
    // In production, this would list from storage
    if (this._data) {
      return [{ id: this._data.id, name: this._data.name, timestamp: this._data.timestamp }];
    }
    return [];
  },

  /**
   * Clear all checkpoints.
   */
  async clear(): Promise<void> {
    this._data = null;
    console.log('[codmir:CHECKPOINT] Cleared');
  },

  /**
   * Delete a specific checkpoint.
   */
  async delete(id: string): Promise<void> {
    if (this._data?.id === id) {
      this._data = null;
    }
    console.log(`[codmir:CHECKPOINT] Deleted: ${id}`);
  },
};

/**
 * Retry helper with exponential backoff.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
    onRetry?: (attempt: number, error: Error) => void;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
    onRetry,
  } = options;

  let lastError: Error | null = null;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt === maxAttempts) {
        break;
      }

      if (onRetry) {
        onRetry(attempt, lastError);
      } else {
        logs.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, {
          error: lastError.message,
        });
      }

      await sleep(delay);
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Sleep helper.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Timeout helper.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = 'Operation timed out'
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

/**
 * Batch processing helper.
 */
export async function batch<T, R>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<R[]>
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batchItems = items.slice(i, i + batchSize);
    const batchResults = await processor(batchItems);
    results.push(...batchResults);
    
    progress.update(Math.min(i + batchSize, items.length));
  }
  
  return results;
}
