/**
 * @codmir/sdk/mcp - MCP Client for programmatic access to Codmir MCP tools
 *
 * Wraps the Codmir MCP server's HTTP API so consumers (VSCode extension,
 * CLI, other agents) can call MCP tools without stdio transport.
 *
 * @example
 * ```typescript
 * import { MCPClient } from '@codmir/sdk/mcp';
 *
 * const mcp = new MCPClient({
 *   apiUrl: 'https://codmir.com',
 *   token: 'your-token',
 *   userId: 'user-id',
 * });
 *
 * const todos = await mcp.listTodo({ projectId: 'proj_123' });
 * await mcp.updateTodoStatus({ projectId: 'proj_123', ticketId: 'TKT-1', status: 'done' });
 * ```
 */

export interface MCPClientConfig {
  apiUrl: string;
  token: string;
  userId: string;
  orgId?: string;
  timeout?: number;
}

export interface MCPToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ListTodoParams {
  projectId: string;
  status?: 'all' | 'open' | 'in_progress' | 'review';
  priority?: 'all' | 'critical' | 'high' | 'medium' | 'low';
  assigneeId?: string;
  limit?: number;
}

export interface UpdateTodoStatusParams {
  projectId: string;
  ticketId: string;
  status: 'open' | 'in_progress' | 'review' | 'done' | 'closed';
}

export interface ExecuteTaskParams {
  projectId: string;
  instructions: string;
  ticketId?: string;
}

export interface CreateTicketParams {
  projectId: string;
  title: string;
  description?: string;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  type?: 'BUG' | 'FEATURE' | 'TASK' | 'IMPROVEMENT';
}

export interface GetSprintTasksParams {
  projectId: string;
  status?: 'all' | 'todo' | 'in_progress' | 'done';
}

export class MCPClient {
  private apiUrl: string;
  private token: string;
  private userId: string;
  private orgId?: string;
  private timeout: number;

  constructor(config: MCPClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.token = config.token;
    this.userId = config.userId;
    this.orgId = config.orgId;
    this.timeout = config.timeout ?? 30000;
  }

  async listTodo(params: ListTodoParams): Promise<MCPToolResult> {
    return this.callTool('list_todo', params as unknown as Record<string, unknown>);
  }

  async updateTodoStatus(params: UpdateTodoStatusParams): Promise<MCPToolResult> {
    return this.callTool('update_todo_status', params as unknown as Record<string, unknown>);
  }

  async executeTask(params: ExecuteTaskParams): Promise<MCPToolResult> {
    return this.callTool('execute_task', params as unknown as Record<string, unknown>);
  }

  async createTicket(params: CreateTicketParams): Promise<MCPToolResult> {
    return this.callTool('create_ticket', params as unknown as Record<string, unknown>);
  }

  async getSprintTasks(params: GetSprintTasksParams): Promise<MCPToolResult> {
    return this.callTool('get_sprint_tasks', params as unknown as Record<string, unknown>);
  }

  async checkTaskStatus(executionId: string): Promise<MCPToolResult> {
    return this.callTool('check_task_status', { executionId });
  }

  async getProjectContext(projectId: string): Promise<MCPToolResult> {
    return this.callTool('get_project_context', { projectId });
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.apiUrl}/api/mcp/${toolName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'X-User-Id': this.userId,
          ...(this.orgId ? { 'X-Org-Id': this.orgId } : {}),
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error');
        return { success: false, error: `HTTP ${response.status}: ${text}` };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: 'Request timed out' };
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }
}
