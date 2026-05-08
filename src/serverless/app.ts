/**
 * @fileoverview
 * Codmir App - Container for serverless functions
 * 
 * Similar to Modal's App but with Grace Foundation governance.
 */

import type { AppConfig, FunctionConfig, SandboxConfig, GraceConfig } from './types';
import { CodmirFunction, createFunction } from './function';
import { CodmirSandbox, createSandbox } from './sandbox';

/**
 * Codmir App - Container for serverless functions and sandboxes.
 * 
 * @example
 * ```typescript
 * const app = new CodmirApp({ name: 'my-app' });
 * 
 * const myFunction = app.function({ cpu: 2, memory: '4GB' })(
 *   async (data: string) => processData(data)
 * );
 * ```
 */
export class CodmirApp {
  readonly name: string;
  readonly config: AppConfig;
  
  private functions: Map<string, CodmirFunction<unknown[], unknown>> = new Map();
  private sandboxes: Map<string, CodmirSandbox> = new Map();
  private deployed = false;

  constructor(config: AppConfig) {
    this.name = config.name;
    this.config = {
      grace: { enabled: true, preferGreen: false },
      ...config,
    };
  }

  /**
   * Create a serverless function.
   * 
   * @example
   * ```typescript
   * const processData = app.function({ cpu: 2, timeout: 300 })(
   *   async (data: string) => {
   *     return data.toUpperCase();
   *   }
   * );
   * ```
   */
  function<TArgs extends unknown[], TReturn>(
    config: FunctionConfig = {}
  ): (handler: (...args: TArgs) => Promise<TReturn>) => CodmirFunction<TArgs, TReturn> {
    return (handler) => {
      const mergedConfig: FunctionConfig = {
        ...config,
        image: config.image || this.config.image,
        secrets: [...(this.config.secrets || []), ...(config.secrets || [])],
        volumes: { ...this.config.volumes, ...config.volumes },
        grace: { ...this.config.grace, ...config.grace },
      };

      const fn = createFunction<TArgs, TReturn>(this, mergedConfig, handler);
      this.functions.set(fn.name, fn as CodmirFunction<unknown[], unknown>);
      return fn;
    };
  }

  /**
   * Create a sandbox for interactive execution.
   * 
   * @example
   * ```typescript
   * const sandbox = await app.sandbox({ image: 'python:3.11' }).spawn();
   * await sandbox.exec('pip install numpy');
   * const result = await sandbox.exec('python -c "import numpy; print(numpy.__version__)"');
   * await sandbox.terminate();
   * ```
   */
  sandbox(config: SandboxConfig): CodmirSandbox {
    const mergedConfig: SandboxConfig = {
      ...config,
      secrets: [...(this.config.secrets || []), ...(config.secrets || [])],
      volumes: { ...this.config.volumes, ...config.volumes },
      grace: { ...this.config.grace, ...config.grace },
    };

    const sandbox = createSandbox(this, mergedConfig);
    this.sandboxes.set(sandbox.name, sandbox);
    return sandbox;
  }

  /**
   * Create a scheduled function (cron).
   */
  cron(schedule: string, config: FunctionConfig = {}) {
    return this.function({ ...config, schedule });
  }

  /**
   * Create a web endpoint function.
   */
  webEndpoint(config: FunctionConfig = {}) {
    return this.function({ ...config });
  }

  /**
   * Deploy the app to Codmir cloud.
   */
  async deploy(): Promise<{ url: string; functions: string[] }> {
    if (this.deployed) {
      throw new Error(`App ${this.name} is already deployed`);
    }

    // In production, this would call the Codmir API
    // For now, we prepare the deployment manifest
    const manifest = {
      name: this.name,
      config: this.config,
      functions: Array.from(this.functions.entries()).map(([name, fn]) => ({
        name,
        config: fn.config,
      })),
    };

    console.log(`[codmir] Deploying app: ${this.name}`);
    console.log(`[codmir] Functions: ${this.functions.size}`);

    this.deployed = true;

    return {
      url: `https://${this.name}.codmir.run`,
      functions: Array.from(this.functions.keys()),
    };
  }

  /**
   * Get a registered function by name.
   */
  getFunction(name: string): CodmirFunction<unknown[], unknown> | undefined {
    return this.functions.get(name);
  }

  /**
   * List all registered functions.
   */
  listFunctions(): string[] {
    return Array.from(this.functions.keys());
  }

  /**
   * Update Grace configuration.
   */
  withGrace(grace: Partial<GraceConfig>): CodmirApp {
    this.config.grace = { ...this.config.grace, ...grace };
    return this;
  }

  /**
   * Serve the app locally for development.
   */
  async serve(port = 8000): Promise<void> {
    console.log(`[codmir] Starting local server on port ${port}`);
    console.log(`[codmir] Functions available:`);
    for (const name of this.functions.keys()) {
      console.log(`  - ${name}: http://localhost:${port}/${name}`);
    }
    // In production, this would start a local server
  }
}

/**
 * Create a new Codmir App.
 */
export function createApp(config: AppConfig): CodmirApp {
  return new CodmirApp(config);
}

/**
 * Convenience namespace for Modal-like API.
 */
export const codmir = {
  App: (config: AppConfig) => new CodmirApp(config),
};
