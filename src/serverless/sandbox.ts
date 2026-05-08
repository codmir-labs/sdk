/**
 * @fileoverview
 * Codmir Sandbox - Interactive execution environment
 * 
 * Similar to Modal's Sandbox but with Grace governance.
 */

import type { CodmirApp } from './app';
import type { SandboxConfig, ExecutionResult, StreamEvent } from './types';

/**
 * Sandbox execution result.
 */
export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Codmir Sandbox - Interactive cloud execution environment.
 * 
 * @example
 * ```typescript
 * const sandbox = app.sandbox({ image: 'python:3.11' });
 * await sandbox.spawn();
 * 
 * // Execute commands
 * await sandbox.exec('pip install numpy pandas');
 * const result = await sandbox.exec('python script.py');
 * 
 * // Read/write files
 * await sandbox.writeFile('/app/data.json', JSON.stringify(data));
 * const content = await sandbox.readFile('/app/output.json');
 * 
 * // Terminate when done
 * await sandbox.terminate();
 * ```
 */
export class CodmirSandbox {
  readonly name: string;
  readonly config: SandboxConfig;
  
  private app: CodmirApp;
  private sandboxId?: string;
  private status: 'created' | 'spawning' | 'running' | 'terminated' = 'created';
  private tunnelUrl?: string;

  constructor(app: CodmirApp, config: SandboxConfig) {
    this.app = app;
    this.config = config;
    this.name = config.name || `sandbox_${Date.now().toString(36)}`;
  }

  /**
   * Spawn the sandbox environment.
   */
  async spawn(): Promise<CodmirSandbox> {
    if (this.status !== 'created') {
      throw new Error(`Sandbox is already ${this.status}`);
    }

    this.status = 'spawning';
    console.log(`[codmir] Spawning sandbox: ${this.name}`);

    // In production, this would call the Codmir API to provision a sandbox
    // For now, simulate the spawn
    this.sandboxId = `sb_${Date.now().toString(36)}`;
    this.status = 'running';

    if (this.config.webAccess) {
      this.tunnelUrl = `https://${this.sandboxId}.sandbox.codmir.run`;
      console.log(`[codmir] Tunnel available at: ${this.tunnelUrl}`);
    }

    console.log(`[codmir] Sandbox ${this.name} is ready`);
    return this;
  }

  /**
   * Execute a command in the sandbox.
   */
  async exec(command: string, options: { timeout?: number; cwd?: string } = {}): Promise<SandboxExecResult> {
    this.ensureRunning();

    const startTime = Date.now();
    console.log(`[codmir] exec: ${command}`);

    // In production, this would send the command to the sandbox
    // For now, return a placeholder result
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Execute a command and stream output.
   */
  async *execStream(command: string): AsyncGenerator<StreamEvent> {
    this.ensureRunning();

    yield { type: 'started', executionId: `exec_${Date.now()}` };
    yield { type: 'log', message: `$ ${command}`, level: 'info' };

    // In production, this would stream real output
    yield { type: 'completed', result: { exitCode: 0 } };
  }

  /**
   * Write a file to the sandbox.
   */
  async writeFile(path: string, content: string | Buffer): Promise<void> {
    this.ensureRunning();
    console.log(`[codmir] writeFile: ${path} (${content.length} bytes)`);
    // In production, this would upload the file to the sandbox
  }

  /**
   * Read a file from the sandbox.
   */
  async readFile(path: string): Promise<string> {
    this.ensureRunning();
    console.log(`[codmir] readFile: ${path}`);
    // In production, this would download the file from the sandbox
    return '';
  }

  /**
   * List files in a directory.
   */
  async listFiles(path: string = '/'): Promise<string[]> {
    this.ensureRunning();
    const result = await this.exec(`ls -la ${path}`);
    return result.stdout.split('\n').filter(Boolean);
  }

  /**
   * Open a tunnel for web access.
   */
  async tunnel(port: number): Promise<string> {
    this.ensureRunning();
    
    if (!this.config.webAccess) {
      throw new Error('Web access not enabled for this sandbox');
    }

    const url = `https://${this.sandboxId}-${port}.sandbox.codmir.run`;
    console.log(`[codmir] Tunnel opened: ${url} -> localhost:${port}`);
    return url;
  }

  /**
   * Get the tunnel URL (if web access enabled).
   */
  getTunnelUrl(): string | undefined {
    return this.tunnelUrl;
  }

  /**
   * Check if sandbox is running.
   */
  isRunning(): boolean {
    return this.status === 'running';
  }

  /**
   * Get sandbox status.
   */
  getStatus(): typeof this.status {
    return this.status;
  }

  /**
   * Terminate the sandbox.
   */
  async terminate(): Promise<void> {
    if (this.status === 'terminated') {
      return;
    }

    console.log(`[codmir] Terminating sandbox: ${this.name}`);
    this.status = 'terminated';
    this.sandboxId = undefined;
    this.tunnelUrl = undefined;
  }

  /**
   * Keep sandbox alive (extend timeout).
   */
  async keepAlive(durationSeconds: number = 300): Promise<void> {
    this.ensureRunning();
    console.log(`[codmir] Extending sandbox timeout by ${durationSeconds}s`);
    // In production, this would call the API to extend the timeout
  }

  /**
   * Create a checkpoint of the current state.
   */
  async checkpoint(name?: string): Promise<string> {
    this.ensureRunning();
    const checkpointId = `cp_${Date.now().toString(36)}`;
    console.log(`[codmir] Created checkpoint: ${checkpointId}`);
    return checkpointId;
  }

  /**
   * Restore from a checkpoint.
   */
  async restore(checkpointId: string): Promise<void> {
    this.ensureRunning();
    console.log(`[codmir] Restoring from checkpoint: ${checkpointId}`);
    // In production, this would restore the sandbox state
  }

  private ensureRunning(): void {
    if (this.status !== 'running') {
      throw new Error(`Sandbox is not running (status: ${this.status})`);
    }
  }
}

/**
 * Create a Codmir sandbox.
 */
export function createSandbox(app: CodmirApp, config: SandboxConfig): CodmirSandbox {
  return new CodmirSandbox(app, config);
}
