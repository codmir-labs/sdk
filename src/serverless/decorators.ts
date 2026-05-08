/**
 * @fileoverview
 * Codmir Decorators - Modal-like decorator API
 * 
 * Provides familiar decorator syntax for defining serverless functions.
 * 
 * @example
 * ```typescript
 * import { app, fn, web_endpoint, cron } from '@codmir/sdk/serverless';
 * 
 * const myApp = app({ name: 'my-app' });
 * 
 * // Basic function
 * const process = fn(myApp, { cpu: 2 })(async (data: string) => {
 *   return data.toUpperCase();
 * });
 * 
 * // Web endpoint
 * const api = web_endpoint(myApp, { method: 'POST' })(async (req) => {
 *   return { status: 'ok' };
 * });
 * 
 * // Scheduled function
 * const daily = cron(myApp, '0 0 * * *')(async () => {
 *   console.log('Daily task');
 * });
 * ```
 */

import { CodmirApp, createApp } from './app';
import { CodmirFunction } from './function';
import type { AppConfig, FunctionConfig } from './types';

/**
 * Create a Codmir app (decorator style).
 */
export function app(config: AppConfig): CodmirApp {
  return createApp(config);
}

/**
 * Define a serverless function (decorator style).
 * 
 * @example
 * ```typescript
 * const processData = fn(app, { cpu: 2, memory: '4GB' })(
 *   async (input: string) => input.toUpperCase()
 * );
 * ```
 */
export function fn<TArgs extends unknown[], TReturn>(
  appInstance: CodmirApp,
  config: FunctionConfig = {}
): (handler: (...args: TArgs) => Promise<TReturn>) => CodmirFunction<TArgs, TReturn> {
  return appInstance.function<TArgs, TReturn>(config);
}

// Alias for 'fn' to avoid reserved word issues
export { fn as function };

/**
 * Define a method on a class (for OOP style).
 * 
 * @example
 * ```typescript
 * class DataProcessor {
 *   \@method(app, { cpu: 2 })
 *   async process(data: string) {
 *     return data.toUpperCase();
 *   }
 * }
 * ```
 */
export function method(
  appInstance: CodmirApp,
  config: FunctionConfig = {}
): MethodDecorator {
  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const fnName = `${target.constructor.name}_${String(propertyKey)}`;
    
    const codmirFn = appInstance.function({
      ...config,
      name: fnName,
    })(originalMethod);

    descriptor.value = function (...args: unknown[]) {
      return codmirFn.call(...args);
    };

    return descriptor;
  };
}

/**
 * Web endpoint configuration.
 */
export interface WebEndpointConfig extends FunctionConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path?: string;
  auth?: boolean;
}

/**
 * Define a web endpoint function.
 * 
 * @example
 * ```typescript
 * const api = web_endpoint(app, { method: 'POST', path: '/process' })(
 *   async (req: Request) => {
 *     const data = await req.json();
 *     return Response.json({ result: data });
 *   }
 * );
 * ```
 */
export function web_endpoint<TArgs extends unknown[], TReturn>(
  appInstance: CodmirApp,
  config: WebEndpointConfig = {}
): (handler: (...args: TArgs) => Promise<TReturn>) => CodmirFunction<TArgs, TReturn> {
  return appInstance.function<TArgs, TReturn>({
    ...config,
    name: config.name || `endpoint_${config.method || 'GET'}_${Date.now().toString(36)}`,
  });
}

/**
 * Define a scheduled (cron) function.
 * 
 * @example
 * ```typescript
 * const dailyReport = cron(app, '0 9 * * *')(async () => {
 *   await generateDailyReport();
 * });
 * ```
 */
export function cron<TArgs extends unknown[], TReturn>(
  appInstance: CodmirApp,
  schedule: string,
  config: FunctionConfig = {}
): (handler: (...args: TArgs) => Promise<TReturn>) => CodmirFunction<TArgs, TReturn> {
  return appInstance.function<TArgs, TReturn>({
    ...config,
    schedule,
    name: config.name || `cron_${schedule.replace(/\s+/g, '_')}_${Date.now().toString(36)}`,
  });
}

/**
 * Define a function with GPU support.
 * 
 * @example
 * ```typescript
 * const inference = gpu(app, 'A100', { memory: '16GB' })(
 *   async (prompt: string) => {
 *     return runInference(prompt);
 *   }
 * );
 * ```
 */
export function gpu<TArgs extends unknown[], TReturn>(
  appInstance: CodmirApp,
  gpuType: 'T4' | 'A10G' | 'A100' | 'H100',
  config: FunctionConfig = {}
): (handler: (...args: TArgs) => Promise<TReturn>) => CodmirFunction<TArgs, TReturn> {
  return appInstance.function<TArgs, TReturn>({
    ...config,
    gpu: gpuType,
    pool: 'modal', // GPU only available on Modal
  });
}

/**
 * Define a long-running function (Fargate).
 * 
 * @example
 * ```typescript
 * const longTask = fargate(app, { timeout: 7200 })(
 *   async (data: LargeDataset) => {
 *     return processLargeDataset(data);
 *   }
 * );
 * ```
 */
export function fargate<TArgs extends unknown[], TReturn>(
  appInstance: CodmirApp,
  config: FunctionConfig = {}
): (handler: (...args: TArgs) => Promise<TReturn>) => CodmirFunction<TArgs, TReturn> {
  return appInstance.function<TArgs, TReturn>({
    ...config,
    pool: 'fargate',
    timeout: config.timeout || 3600, // Default 1 hour
  });
}

/**
 * Define a batch function (GitHub Actions - free tier).
 * 
 * @example
 * ```typescript
 * const batchJob = batch(app)(async (items: string[]) => {
 *   return items.map(process);
 * });
 * ```
 */
export function batch<TArgs extends unknown[], TReturn>(
  appInstance: CodmirApp,
  config: FunctionConfig = {}
): (handler: (...args: TArgs) => Promise<TReturn>) => CodmirFunction<TArgs, TReturn> {
  return appInstance.function<TArgs, TReturn>({
    ...config,
    pool: 'github',
  });
}

/**
 * Define a green (low-carbon) function.
 * 
 * @example
 * ```typescript
 * const ecoFriendly = green(app)(async (data: string) => {
 *   return process(data);
 * });
 * ```
 */
export function green<TArgs extends unknown[], TReturn>(
  appInstance: CodmirApp,
  config: FunctionConfig = {}
): (handler: (...args: TArgs) => Promise<TReturn>) => CodmirFunction<TArgs, TReturn> {
  return appInstance.function<TArgs, TReturn>({
    ...config,
    grace: {
      ...config.grace,
      preferGreen: true,
    },
  });
}
