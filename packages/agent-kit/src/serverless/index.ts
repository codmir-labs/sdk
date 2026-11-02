/**
 * @fileoverview
 * Codmir Serverless AI Execution SDK
 * 
 * Alternative to Modal.com with Grace Foundation principles.
 * 
 * Key differences from Modal:
 * - Contract-based execution with ethical governance
 * - Hybrid execution (Modal/Fargate/GitHub/Community)
 * - Built-in audit trails and reversibility
 * - Carbon-aware routing
 * - Grace policy enforcement
 * 
 * @example
 * ```typescript
 * import { codmir, function as fn } from '@codmir/sdk/serverless';
 * 
 * const app = codmir.App({ name: 'my-app' });
 * 
 * const processData = fn(app, {
 *   cpu: 2,
 *   memory: '4GB',
 *   timeout: 300,
 * })(async (data: string) => {
 *   // Your code runs in the cloud
 *   return processedResult;
 * });
 * 
 * // Local development
 * const result = await processData.local('test data');
 * 
 * // Cloud execution
 * const result = await processData.remote('real data');
 * ```
 */

export { CodmirApp, createApp } from './app';
export { CodmirFunction, createFunction } from './function';
export { CodmirSandbox, createSandbox } from './sandbox';
export { CodmirImage, createImage } from './image';
export { CodmirVolume, createVolume } from './volume';
export { CodmirSecret, createSecret } from './secret';

export type {
  AppConfig,
  FunctionConfig,
  SandboxConfig,
  ImageConfig,
  VolumeConfig,
  SecretConfig,
  ExecutionResult,
  ExecutionStatus,
  ResourceSpec,
  GraceConfig,
} from './types';

// Re-export decorators for Modal-like API
export { app, function as fn, method, web_endpoint, cron } from './decorators';

// Execution layer
export { execute, executeAsync, executeLocal } from './execution';

// Utilities
export { logs, progress, checkpoint } from './utils';
