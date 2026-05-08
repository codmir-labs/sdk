/**
 * Framework Helper - Convenience methods for agent-minion framework
 * 
 * Provides a fluent API for building framework tasks within the existing SDK
 */

import { 
  FrameworkTaskRequest, 
  TaskComplexity, 
  TaskPriority, 
  ExecutionEnvironment 
} from './types';

export class FrameworkTaskBuilder {
  private request: Partial<FrameworkTaskRequest> = {
    context: { projectId: '', userId: '' },
    preferences: {},
  };

  setTitle(title: string): FrameworkTaskBuilder {
    this.request.title = title;
    return this;
  }

  setDescription(description: string): FrameworkTaskBuilder {
    this.request.description = description;
    return this;
  }

  setType(type: FrameworkTaskRequest['type']): FrameworkTaskBuilder {
    this.request.type = type;
    return this;
  }

  setComplexity(complexity: TaskComplexity): FrameworkTaskBuilder {
    this.request.complexity = complexity;
    return this;
  }

  setPriority(priority: TaskPriority): FrameworkTaskBuilder {
    this.request.priority = priority;
    return this;
  }

  setProject(projectId: string, userId: string): FrameworkTaskBuilder {
    this.request.context!.projectId = projectId;
    this.request.context!.userId = userId;
    return this;
  }

  addFiles(files: string[]): FrameworkTaskBuilder {
    this.request.context!.files = [...(this.request.context!.files || []), ...files];
    return this;
  }

  setRepository(url: string, branch?: string): FrameworkTaskBuilder {
    this.request.context!.repository = { url, branch };
    return this;
  }

  setEnvironment(env: Record<string, any>): FrameworkTaskBuilder {
    this.request.context!.environment = { ...this.request.context!.environment, ...env };
    return this;
  }

  preferEnvironment(env: ExecutionEnvironment): FrameworkTaskBuilder {
    this.request.preferences!.executionEnvironment = env;
    return this;
  }

  setMaxDuration(minutes: number): FrameworkTaskBuilder {
    this.request.preferences!.maxDuration = minutes;
    return this;
  }

  setCostLimit(dollars: number): FrameworkTaskBuilder {
    this.request.preferences!.costLimit = dollars;
    return this;
  }

  requireApproval(required: boolean = true): FrameworkTaskBuilder {
    this.request.preferences!.requireApproval = required;
    return this;
  }

  build(): FrameworkTaskRequest {
    if (!this.request.title) {
      throw new Error('Task title is required');
    }
    if (!this.request.description) {
      throw new Error('Task description is required');
    }
    if (!this.request.type) {
      throw new Error('Task type is required');
    }
    if (!this.request.context?.projectId) {
      throw new Error('Project ID is required');
    }
    if (!this.request.context?.userId) {
      throw new Error('User ID is required');
    }

    return this.request as FrameworkTaskRequest;
  }
}

/**
 * Convenience functions for common framework tasks
 */
export class FrameworkHelpers {
  /**
   * Create a code analysis task (perfect for "analyze components in this package")
   */
  static createCodeAnalysisTask(
    projectId: string,
    userId: string,
    description: string,
    files?: string[]
  ): FrameworkTaskRequest {
    return new FrameworkTaskBuilder()
      .setTitle('Code Analysis')
      .setDescription(description)
      .setType('code_analysis')
      .setComplexity('medium')
      .setProject(projectId, userId)
      .addFiles(files || [])
      .preferEnvironment('hybrid') // Use both agents and minions
      .build();
  }

  /**
   * Create a file processing task
   */
  static createFileProcessingTask(
    projectId: string,
    userId: string,
    description: string,
    files: string[]
  ): FrameworkTaskRequest {
    return new FrameworkTaskBuilder()
      .setTitle('File Processing')
      .setDescription(description)
      .setType('file_processing')
      .setComplexity('simple')
      .setProject(projectId, userId)
      .addFiles(files)
      .preferEnvironment('worker_minion') // Perfect for minions
      .build();
  }

  /**
   * Create a full feature development task
   */
  static createFeatureDevelopmentTask(
    projectId: string,
    userId: string,
    description: string,
    repoUrl?: string,
    branch?: string
  ): FrameworkTaskRequest {
    const builder = new FrameworkTaskBuilder()
      .setTitle('Feature Development')
      .setDescription(description)
      .setType('full_feature_development')
      .setComplexity('complex')
      .setProject(projectId, userId)
      .preferEnvironment('hybrid')
      .setMaxDuration(60); // 1 hour

    if (repoUrl) {
      builder.setRepository(repoUrl, branch);
    }

    return builder.build();
  }

  /**
   * Create a documentation task
   */
  static createDocumentationTask(
    projectId: string,
    userId: string,
    description: string,
    files?: string[]
  ): FrameworkTaskRequest {
    return new FrameworkTaskBuilder()
      .setTitle('Documentation Generation')
      .setDescription(description)
      .setType('documentation')
      .setComplexity('simple')
      .setProject(projectId, userId)
      .addFiles(files || [])
      .preferEnvironment('worker_minion') // Great for minions
      .build();
  }
}
