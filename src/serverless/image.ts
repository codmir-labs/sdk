/**
 * @fileoverview
 * Codmir Image - Container image builder
 * 
 * Build custom container images for serverless functions.
 */

import type { ImageConfig } from './types';

/**
 * Codmir Image - Custom container image builder.
 * 
 * @example
 * ```typescript
 * const image = new CodmirImage({ base: 'python:3.11-slim' })
 *   .pip('numpy', 'pandas', 'scikit-learn')
 *   .apt('libgomp1')
 *   .run('python -m pip install --upgrade pip')
 *   .copy('./models', '/app/models')
 *   .env({ MODEL_PATH: '/app/models' })
 *   .workdir('/app');
 * 
 * const app = codmir.App({ name: 'ml-app', image });
 * ```
 */
export class CodmirImage {
  private config: ImageConfig;

  constructor(config: ImageConfig | string) {
    if (typeof config === 'string') {
      this.config = { base: config };
    } else {
      this.config = config;
    }
  }

  /**
   * Install Python packages via pip.
   */
  pip(...packages: string[]): CodmirImage {
    this.config.pythonPackages = [
      ...(this.config.pythonPackages || []),
      ...packages,
    ];
    return this;
  }

  /**
   * Install Python packages from requirements.txt.
   */
  pipRequirements(path: string): CodmirImage {
    this.config.pipRequirements = path;
    return this;
  }

  /**
   * Install system packages via apt-get.
   */
  apt(...packages: string[]): CodmirImage {
    this.config.systemPackages = [
      ...(this.config.systemPackages || []),
      ...packages,
    ];
    return this;
  }

  /**
   * Run a command during image build.
   */
  run(command: string): CodmirImage {
    this.config.runCommands = [
      ...(this.config.runCommands || []),
      command,
    ];
    return this;
  }

  /**
   * Copy files into the image.
   */
  copy(from: string, to: string): CodmirImage {
    this.config.copyFiles = [
      ...(this.config.copyFiles || []),
      { from, to },
    ];
    return this;
  }

  /**
   * Set environment variables.
   */
  env(vars: Record<string, string>): CodmirImage {
    this.config.env = {
      ...this.config.env,
      ...vars,
    };
    return this;
  }

  /**
   * Set working directory.
   */
  workdir(path: string): CodmirImage {
    this.config.workdir = path;
    return this;
  }

  /**
   * Get the image configuration.
   */
  getConfig(): ImageConfig {
    return this.config;
  }

  /**
   * Generate Dockerfile content.
   */
  toDockerfile(): string {
    const lines: string[] = [];

    lines.push(`FROM ${this.config.base}`);
    lines.push('');

    // System packages
    if (this.config.systemPackages?.length) {
      lines.push('RUN apt-get update && apt-get install -y \\');
      lines.push(`    ${this.config.systemPackages.join(' \\\n    ')} \\`);
      lines.push('    && rm -rf /var/lib/apt/lists/*');
      lines.push('');
    }

    // Working directory
    if (this.config.workdir) {
      lines.push(`WORKDIR ${this.config.workdir}`);
      lines.push('');
    }

    // Copy files
    if (this.config.copyFiles?.length) {
      for (const { from, to } of this.config.copyFiles) {
        lines.push(`COPY ${from} ${to}`);
      }
      lines.push('');
    }

    // Requirements file
    if (this.config.pipRequirements) {
      lines.push(`COPY ${this.config.pipRequirements} /tmp/requirements.txt`);
      lines.push('RUN pip install --no-cache-dir -r /tmp/requirements.txt');
      lines.push('');
    }

    // Python packages
    if (this.config.pythonPackages?.length) {
      lines.push(`RUN pip install --no-cache-dir ${this.config.pythonPackages.join(' ')}`);
      lines.push('');
    }

    // Run commands
    if (this.config.runCommands?.length) {
      for (const cmd of this.config.runCommands) {
        lines.push(`RUN ${cmd}`);
      }
      lines.push('');
    }

    // Environment variables
    if (this.config.env) {
      for (const [key, value] of Object.entries(this.config.env)) {
        lines.push(`ENV ${key}="${value}"`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

/**
 * Create a Codmir image.
 */
export function createImage(config: ImageConfig | string): CodmirImage {
  return new CodmirImage(config);
}

/**
 * Pre-built images for common use cases.
 */
export const Images = {
  /** Python 3.11 slim */
  python311: () => new CodmirImage({ base: 'python:3.11-slim' }),
  
  /** Python 3.11 with scientific computing */
  pythonScientific: () => new CodmirImage({ base: 'python:3.11-slim' })
    .apt('libgomp1')
    .pip('numpy', 'pandas', 'scipy', 'scikit-learn'),
  
  /** Python with PyTorch */
  pytorch: () => new CodmirImage({ base: 'pytorch/pytorch:2.0.1-cuda11.7-cudnn8-runtime' }),
  
  /** Node.js 20 */
  node20: () => new CodmirImage({ base: 'node:20-slim' }),
  
  /** Node.js with common tools */
  nodeWithTools: () => new CodmirImage({ base: 'node:20-slim' })
    .apt('git', 'curl')
    .run('npm install -g pnpm'),
  
  /** Debian slim */
  debian: () => new CodmirImage({ base: 'debian:bookworm-slim' }),
  
  /** Alpine */
  alpine: () => new CodmirImage({ base: 'alpine:3.19' }),
};
