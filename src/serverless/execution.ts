/**
 * @fileoverview
 * Codmir Execution Layer - Hybrid cloud execution
 * 
 * Routes execution to the best available pool:
 * - Modal: Fast serverless, GPU support
 * - Fargate: Long-running tasks
 * - GitHub: Batch jobs, free tier
 * - Community: Distributed compute
 * - Local: Development
 */

import type {
  FunctionConfig,
  ExecutionResult,
  ExecutionPool,
  GraceConfig,
  ExecutionMetrics,
} from './types';

/**
 * Execution request.
 */
export interface ExecutionRequest<TArgs extends unknown[]> {
  appName: string;
  functionName: string;
  args: TArgs;
  config: FunctionConfig;
  grace?: GraceConfig;
  wait?: boolean;
  callbackUrl?: string;
}

/**
 * Pool configuration for routing decisions.
 */
const POOL_CONFIG: Record<ExecutionPool, {
  maxTimeout: number;
  coldStartMs: number;
  costPerMinute: number;
  gpuSupport: boolean;
  carbonScore: number;
}> = {
  modal: {
    maxTimeout: 3600,      // 1 hour
    coldStartMs: 300,
    costPerMinute: 2,
    gpuSupport: true,
    carbonScore: 60,
  },
  fargate: {
    maxTimeout: 86400,     // 24 hours
    coldStartMs: 60000,
    costPerMinute: 1,
    gpuSupport: false,
    carbonScore: 50,
  },
  github: {
    maxTimeout: 21600,     // 6 hours
    coldStartMs: 30000,
    costPerMinute: 0,
    gpuSupport: false,
    carbonScore: 70,
  },
  community: {
    maxTimeout: 3600,
    coldStartMs: 5000,
    costPerMinute: 0.5,
    gpuSupport: false,
    carbonScore: 80,
  },
  local: {
    maxTimeout: Infinity,
    coldStartMs: 0,
    costPerMinute: 0,
    gpuSupport: false,
    carbonScore: 100,
  },
  auto: {
    maxTimeout: Infinity,
    coldStartMs: 0,
    costPerMinute: 0,
    gpuSupport: true,
    carbonScore: 50,
  },
};

/**
 * Select the best execution pool based on requirements.
 */
function selectPool(config: FunctionConfig, grace?: GraceConfig): ExecutionPool {
  // If pool is explicitly specified, use it
  if (config.pool && config.pool !== 'auto') {
    return config.pool;
  }

  const timeout = config.timeout || 300;
  const needsGpu = !!config.gpu;
  const preferGreen = grace?.preferGreen ?? false;

  // GPU required -> Modal
  if (needsGpu) {
    return 'modal';
  }

  // Long running (>1 hour) -> Fargate
  if (timeout > 3600) {
    return 'fargate';
  }

  // Low budget -> GitHub (free)
  if (grace?.maxBudget !== undefined && grace.maxBudget < 10) {
    return 'github';
  }

  // Prefer green -> Community or GitHub
  if (preferGreen) {
    return timeout > 3600 ? 'fargate' : 'github';
  }

  // Default -> Modal for speed
  return 'modal';
}

/**
 * Execute a function synchronously.
 */
export async function execute<TArgs extends unknown[], TReturn>(
  request: ExecutionRequest<TArgs>
): Promise<ExecutionResult<TReturn>> {
  const startTime = Date.now();
  const pool = selectPool(request.config, request.grace);
  const executionId = `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  console.log(`[codmir] Executing ${request.functionName} on ${pool}`);

  try {
    // Route to appropriate pool
    let result: TReturn;
    
    switch (pool) {
      case 'local':
        throw new Error('Use executeLocal for local execution');
      
      case 'modal':
        result = await executeOnModal<TArgs, TReturn>(request);
        break;
      
      case 'fargate':
        result = await executeOnFargate<TArgs, TReturn>(request);
        break;
      
      case 'github':
        result = await executeOnGitHub<TArgs, TReturn>(request);
        break;
      
      case 'community':
        result = await executeOnCommunity<TArgs, TReturn>(request);
        break;
      
      default:
        result = await executeOnModal<TArgs, TReturn>(request);
    }

    const durationMs = Date.now() - startTime;
    const creditsUsed = Math.ceil(durationMs / 60000) * POOL_CONFIG[pool].costPerMinute;

    return {
      id: executionId,
      status: 'completed',
      result,
      metrics: {
        durationMs,
        coldStartMs: POOL_CONFIG[pool].coldStartMs,
        creditsUsed,
        carbonFootprint: estimateCarbonFootprint(durationMs, pool),
        pool,
      },
    };

  } catch (error) {
    return {
      id: executionId,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      metrics: {
        durationMs: Date.now() - startTime,
        creditsUsed: 0,
        pool,
      },
    };
  }
}

/**
 * Execute a function asynchronously (fire-and-forget).
 */
export async function executeAsync<TArgs extends unknown[]>(
  request: ExecutionRequest<TArgs>
): Promise<string> {
  const executionId = `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const pool = selectPool(request.config, request.grace);

  console.log(`[codmir] Spawning async execution ${executionId} on ${pool}`);

  // In production, this would submit to a job queue
  // For now, we start execution in the background
  setImmediate(async () => {
    try {
      await execute(request);
    } catch (error) {
      console.error(`[codmir] Async execution ${executionId} failed:`, error);
    }
  });

  return executionId;
}

/**
 * Execute locally (for development).
 */
export async function executeLocal<TArgs extends unknown[], TReturn>(
  handler: (...args: TArgs) => Promise<TReturn>,
  args: TArgs
): Promise<TReturn> {
  return handler(...args);
}

/**
 * Execute on Modal (fast serverless).
 */
async function executeOnModal<TArgs extends unknown[], TReturn>(
  request: ExecutionRequest<TArgs>
): Promise<TReturn> {
  const apiUrl = process.env.CODMIR_API_URL || 'https://codmir.com';
  const apiKey = process.env.CODMIR_API_KEY;

  if (!apiKey) {
    throw new Error('CODMIR_API_KEY is required for remote execution');
  }

  // In production, this would call the Codmir API which routes to Modal
  const response = await fetch(`${apiUrl}/api/cloud/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      pool: 'modal',
      appName: request.appName,
      functionName: request.functionName,
      args: request.args,
      config: request.config,
      grace: request.grace,
    }),
  });

  if (!response.ok) {
    throw new Error(`Modal execution failed: ${response.statusText}`);
  }

  const data = await response.json();
  
  if (request.wait !== false) {
    // Poll for completion
    return await pollForResult<TReturn>(data.jobId);
  }

  return data.jobId;
}

/**
 * Execute on Fargate (long-running).
 */
async function executeOnFargate<TArgs extends unknown[], TReturn>(
  request: ExecutionRequest<TArgs>
): Promise<TReturn> {
  const apiUrl = process.env.CODMIR_API_URL || 'https://codmir.com';
  const apiKey = process.env.CODMIR_API_KEY;

  if (!apiKey) {
    throw new Error('CODMIR_API_KEY is required for remote execution');
  }

  const response = await fetch(`${apiUrl}/api/cloud/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      pool: 'fargate',
      appName: request.appName,
      functionName: request.functionName,
      args: request.args,
      config: request.config,
      grace: request.grace,
    }),
  });

  if (!response.ok) {
    throw new Error(`Fargate execution failed: ${response.statusText}`);
  }

  const data = await response.json();
  
  if (request.wait !== false) {
    return await pollForResult<TReturn>(data.jobId);
  }

  return data.jobId;
}

/**
 * Execute on GitHub Actions (batch/free).
 */
async function executeOnGitHub<TArgs extends unknown[], TReturn>(
  request: ExecutionRequest<TArgs>
): Promise<TReturn> {
  const apiUrl = process.env.CODMIR_API_URL || 'https://codmir.com';
  const apiKey = process.env.CODMIR_API_KEY;

  if (!apiKey) {
    throw new Error('CODMIR_API_KEY is required for remote execution');
  }

  const response = await fetch(`${apiUrl}/api/cloud/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      pool: 'github',
      appName: request.appName,
      functionName: request.functionName,
      args: request.args,
      config: request.config,
      grace: request.grace,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub execution failed: ${response.statusText}`);
  }

  const data = await response.json();
  
  if (request.wait !== false) {
    return await pollForResult<TReturn>(data.jobId);
  }

  return data.jobId;
}

/**
 * Execute on community nodes (distributed).
 */
async function executeOnCommunity<TArgs extends unknown[], TReturn>(
  request: ExecutionRequest<TArgs>
): Promise<TReturn> {
  // Community execution is similar to Modal but routes to community nodes
  return executeOnModal(request);
}

/**
 * Poll for execution result.
 */
async function pollForResult<TReturn>(jobId: string): Promise<TReturn> {
  const apiUrl = process.env.CODMIR_API_URL || 'https://codmir.com';
  const apiKey = process.env.CODMIR_API_KEY;
  const maxWait = 300000; // 5 minutes max wait
  const pollInterval = 1000; // 1 second
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const response = await fetch(`${apiUrl}/api/cloud/jobs/${jobId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get job status: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.status === 'COMPLETED') {
      return data.output as TReturn;
    }

    if (data.status === 'FAILED') {
      throw new Error(data.error || 'Execution failed');
    }

    if (data.status === 'CANCELLED') {
      throw new Error('Execution was cancelled');
    }

    await sleep(pollInterval);
  }

  throw new Error('Execution timed out waiting for result');
}

/**
 * Estimate carbon footprint for execution.
 */
function estimateCarbonFootprint(durationMs: number, pool: ExecutionPool): number {
  // Base estimate: grams CO2e per minute
  const baseEmission = 0.5;
  const minutes = durationMs / 60000;
  const carbonScore = POOL_CONFIG[pool].carbonScore;
  
  // Lower carbon score = higher emissions
  const multiplier = 2 - (carbonScore / 100);
  
  return baseEmission * minutes * multiplier;
}

/**
 * Sleep helper.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
