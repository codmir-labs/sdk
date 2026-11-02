/**
 * @fileoverview
 * Codmir Serverless SDK Types
 * 
 * Type definitions for the serverless AI execution layer.
 */

// @codmir/contracts does not exist; define GraceExtensions inline
type GraceExtensions = Record<string, unknown>;

/**
 * Resource specification for function execution.
 */
export interface ResourceSpec {
  /** CPU cores (e.g., 1, 2, 4) */
  cpu?: number;
  /** Memory in GB or string (e.g., 4 or '4GB') */
  memory?: number | string;
  /** GPU type or boolean */
  gpu?: boolean | 'T4' | 'A10G' | 'A100' | 'H100';
  /** Ephemeral disk in GB */
  disk?: number;
}

/**
 * Execution pool for hybrid routing.
 */
export type ExecutionPool = 'modal' | 'fargate' | 'github' | 'community' | 'local' | 'auto';

/**
 * Grace configuration for ethical execution.
 */
export interface GraceConfig {
  /** Enable Grace policy enforcement */
  enabled?: boolean;
  /** Require human approval for execution */
  requireApproval?: boolean;
  /** Maximum budget in credits */
  maxBudget?: number;
  /** Prefer green (low-carbon) compute */
  preferGreen?: boolean;
  /** Ethical impact category */
  impactCategory?: 'safe' | 'low' | 'medium' | 'high';
  /** Custom Grace extensions */
  extensions?: Partial<GraceExtensions>;
}

/**
 * App configuration.
 */
export interface AppConfig {
  /** Unique app name */
  name: string;
  /** Default image for functions */
  image?: string;
  /** Default secrets */
  secrets?: string[];
  /** Default volumes */
  volumes?: Record<string, string>;
  /** Grace configuration */
  grace?: GraceConfig;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Function configuration.
 */
export interface FunctionConfig {
  /** Function name (auto-generated if not provided) */
  name?: string;
  /** Resource specification */
  cpu?: number;
  memory?: number | string;
  gpu?: boolean | string;
  /** Timeout in seconds */
  timeout?: number;
  /** Number of retries on failure */
  retries?: number;
  /** Concurrency limit */
  concurrencyLimit?: number;
  /** Preferred execution pool */
  pool?: ExecutionPool;
  /** Container image */
  image?: string;
  /** Secrets to inject */
  secrets?: string[];
  /** Volume mounts */
  volumes?: Record<string, string>;
  /** Environment variables */
  env?: Record<string, string>;
  /** Grace configuration */
  grace?: GraceConfig;
  /** Enable checkpointing for long tasks */
  checkpoints?: boolean;
  /** Schedule (cron expression) */
  schedule?: string;
}

/**
 * Sandbox configuration for interactive execution.
 */
export interface SandboxConfig {
  /** Sandbox name */
  name?: string;
  /** Base image */
  image: string;
  /** Resource specification */
  cpu?: number;
  memory?: number | string;
  gpu?: boolean | string;
  /** Timeout in seconds (default: 3600) */
  timeout?: number;
  /** Working directory */
  workdir?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Secrets to inject */
  secrets?: string[];
  /** Volume mounts */
  volumes?: Record<string, string>;
  /** Enable web access via tunnel */
  webAccess?: boolean;
  /** Grace configuration */
  grace?: GraceConfig;
}

/**
 * Image configuration for custom containers.
 */
export interface ImageConfig {
  /** Base image */
  base: string;
  /** Python packages to install */
  pythonPackages?: string[];
  /** System packages to install */
  systemPackages?: string[];
  /** pip requirements file */
  pipRequirements?: string;
  /** Commands to run during build */
  runCommands?: string[];
  /** Files to copy into image */
  copyFiles?: Array<{ from: string; to: string }>;
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  workdir?: string;
}

/**
 * Volume configuration for persistent storage.
 */
export interface VolumeConfig {
  /** Volume name */
  name: string;
  /** Size in GB */
  size?: number;
  /** Region for data locality */
  region?: string;
}

/**
 * Secret configuration.
 */
export interface SecretConfig {
  /** Secret name */
  name: string;
  /** Environment variable name to inject as */
  envVar?: string;
}

/**
 * Execution status.
 */
export type ExecutionStatus = 
  | 'pending'
  | 'queued'
  | 'running'
  | 'checkpointed'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

/**
 * Execution result.
 */
export interface ExecutionResult<T = unknown> {
  /** Execution ID */
  id: string;
  /** Status */
  status: ExecutionStatus;
  /** Result data (if completed) */
  result?: T;
  /** Error message (if failed) */
  error?: string;
  /** Execution metrics */
  metrics: ExecutionMetrics;
  /** Logs */
  logs?: string[];
  /** Artifacts produced */
  artifacts?: ExecutionArtifact[];
  /** Checkpoint data (if checkpointed) */
  checkpoint?: unknown;
}

/**
 * Execution metrics.
 */
export interface ExecutionMetrics {
  /** Total execution time in ms */
  durationMs: number;
  /** Time spent queued in ms */
  queuedMs?: number;
  /** Cold start time in ms */
  coldStartMs?: number;
  /** CPU usage percentage */
  cpuUsage?: number;
  /** Memory usage in MB */
  memoryUsageMb?: number;
  /** Credits consumed */
  creditsUsed: number;
  /** Estimated carbon footprint (gCO2e) */
  carbonFootprint?: number;
  /** Execution pool used */
  pool: ExecutionPool;
  /** Worker ID */
  workerId?: string;
}

/**
 * Execution artifact.
 */
export interface ExecutionArtifact {
  /** Artifact type */
  type: 'file' | 'url' | 'commit' | 'deployment';
  /** Artifact name */
  name: string;
  /** Artifact URL or path */
  url?: string;
  /** Size in bytes */
  size?: number;
  /** Content type */
  contentType?: string;
}

/**
 * Function call options.
 */
export interface CallOptions {
  /** Override timeout */
  timeout?: number;
  /** Override pool */
  pool?: ExecutionPool;
  /** Wait for completion */
  wait?: boolean;
  /** Callback URL for async execution */
  callbackUrl?: string;
  /** Grace overrides */
  grace?: Partial<GraceConfig>;
}

/**
 * Stream event types.
 */
export type StreamEvent =
  | { type: 'started'; executionId: string }
  | { type: 'log'; message: string; level: 'info' | 'warn' | 'error' }
  | { type: 'progress'; percent: number; message?: string }
  | { type: 'checkpoint'; data: unknown }
  | { type: 'artifact'; artifact: ExecutionArtifact }
  | { type: 'completed'; result: unknown }
  | { type: 'failed'; error: string }
  | { type: 'cancelled' };

/**
 * Batch job configuration.
 */
export interface BatchConfig {
  /** Maximum concurrent executions */
  maxConcurrency?: number;
  /** Retry failed items */
  retryFailed?: boolean;
  /** Continue on errors */
  continueOnError?: boolean;
  /** Progress callback */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Batch result.
 */
export interface BatchResult<T> {
  /** Total items processed */
  total: number;
  /** Successful results */
  successful: Array<{ index: number; result: T }>;
  /** Failed items */
  failed: Array<{ index: number; error: string }>;
  /** Aggregate metrics */
  metrics: {
    totalDurationMs: number;
    totalCreditsUsed: number;
    totalCarbonFootprint: number;
  };
}
