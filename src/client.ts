import {
  type CodmirClientConfig,
  type ApiResponse,
  type PaginatedResponse,
  type Project,
  type CreateProjectInput,
  type Ticket,
  type CreateTicketInput,
  type UpdateTicketInput,
  type TestCase,
  type CreateTestCaseInput,
  type UpdateTestCaseInput,
  type AgentTask,
  type CreateAgentTaskInput,
  type RunTaskInput,
  type TaskExecution,
  type TestRunSummaryInput,
  type CoverageInsightRequest,
  type CoverageInsight,
  type User,
  type FrameworkTaskRequest,
  type FrameworkTaskResponse,
  type FrameworkTaskStatus,
  type FrameworkResourceStatus,
  type FrameworkMetrics,
  CodmirApiError,
} from "./types";

const DEFAULT_BASE_URL = "https://codmir.com/api";
const DEFAULT_TIMEOUT = 30000;

export class CodmirClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeout: number;
  private headers: Record<string, string>;

  constructor(config: CodmirClientConfig = {}) {
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.apiKey = config.apiKey || process.env.CODMIR_API_KEY;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.headers = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    if (this.apiKey) {
      this.headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
  }

  // ============================================
  // HTTP Methods
  // ============================================

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new CodmirApiError(
          errorData.code || "API_ERROR",
          errorData.message || `HTTP ${response.status}`,
          response.status,
          errorData.details
        );
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof CodmirApiError) {
        throw error;
      }
      
      if (error instanceof Error && error.name === "AbortError") {
        throw new CodmirApiError("TIMEOUT", "Request timed out", 408);
      }
      
      throw new CodmirApiError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  private delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  // ============================================
  // Auth
  // ============================================

  async whoami(): Promise<User> {
    const response = await this.get<ApiResponse<User>>("/auth/me");
    return response.data;
  }

  // ============================================
  // Projects
  // ============================================

  async listProjects(): Promise<Project[]> {
    const response = await this.get<ApiResponse<Project[]>>("/projects");
    return response.data;
  }

  async getProject(projectId: string): Promise<Project> {
    const response = await this.get<ApiResponse<Project>>(`/projects/${projectId}`);
    return response.data;
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const response = await this.post<ApiResponse<Project>>("/projects", input);
    return response.data;
  }

  // ============================================
  // Tickets
  // ============================================

  async listTickets(
    projectId: string,
    options?: { page?: number; pageSize?: number; status?: string }
  ): Promise<PaginatedResponse<Ticket>> {
    const params = new URLSearchParams();
    if (options?.page) params.set("page", String(options.page));
    if (options?.pageSize) params.set("pageSize", String(options.pageSize));
    if (options?.status) params.set("status", options.status);
    
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.get<PaginatedResponse<Ticket>>(`/projects/${projectId}/tickets${query}`);
  }

  async getTicket(projectId: string, ticketId: string): Promise<Ticket> {
    const response = await this.get<ApiResponse<Ticket>>(
      `/projects/${projectId}/tickets/${ticketId}`
    );
    return response.data;
  }

  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const response = await this.post<ApiResponse<Ticket>>(
      `/projects/${input.projectId}/tickets`,
      input
    );
    return response.data;
  }

  async updateTicket(
    projectId: string,
    ticketId: string,
    input: UpdateTicketInput
  ): Promise<Ticket> {
    const response = await this.patch<ApiResponse<Ticket>>(
      `/projects/${projectId}/tickets/${ticketId}`,
      input
    );
    return response.data;
  }

  async deleteTicket(projectId: string, ticketId: string): Promise<void> {
    await this.delete(`/projects/${projectId}/tickets/${ticketId}`);
  }

  // ============================================
  // Test Cases
  // ============================================

  async listTestCases(projectId: string): Promise<TestCase[]> {
    const response = await this.get<ApiResponse<TestCase[]>>(
      `/projects/${projectId}/test-cases`
    );
    return response.data;
  }

  async getTestCase(projectId: string, testCaseId: string): Promise<TestCase> {
    const response = await this.get<ApiResponse<TestCase>>(
      `/projects/${projectId}/test-cases/${testCaseId}`
    );
    return response.data;
  }

  async createTestCase(input: CreateTestCaseInput): Promise<TestCase> {
    const response = await this.post<ApiResponse<TestCase>>(
      `/projects/${input.projectId}/test-cases`,
      input
    );
    return response.data;
  }

  async updateTestCase(
    projectId: string,
    testCaseId: string,
    input: UpdateTestCaseInput
  ): Promise<TestCase> {
    const response = await this.patch<ApiResponse<TestCase>>(
      `/projects/${projectId}/test-cases/${testCaseId}`,
      input
    );
    return response.data;
  }

  // ============================================
  // Test Insights
  // ============================================

  async submitTestRunSummary(input: TestRunSummaryInput): Promise<void> {
    await this.post(`/projects/${input.projectId}/test-runs`, input);
  }

  async getCoverageInsights(
    request: CoverageInsightRequest
  ): Promise<CoverageInsight> {
    const response = await this.post<ApiResponse<CoverageInsight>>(
      `/projects/${request.projectId}/coverage/insights`,
      request
    );
    return response.data;
  }

  // ============================================
  // Agent Tasks
  // ============================================

  async listAgentTasks(projectId?: string): Promise<AgentTask[]> {
    const path = projectId
      ? `/projects/${projectId}/agent/tasks`
      : "/agent/tasks";
    const response = await this.get<ApiResponse<AgentTask[]>>(path);
    return response.data;
  }

  async getAgentTask(taskId: string): Promise<AgentTask> {
    const response = await this.get<ApiResponse<AgentTask>>(
      `/agent/tasks/${taskId}`
    );
    return response.data;
  }

  async createAgentTask(input: CreateAgentTaskInput): Promise<AgentTask> {
    const path = input.projectId
      ? `/projects/${input.projectId}/agent/tasks`
      : "/agent/tasks";
    const response = await this.post<ApiResponse<AgentTask>>(path, input);
    return response.data;
  }

  async runAgentTask(input: RunTaskInput): Promise<TaskExecution> {
    const response = await this.post<ApiResponse<TaskExecution>>(
      `/agent/tasks/${input.taskId}/run`,
      input.options
    );
    return response.data;
  }

  async cancelAgentTask(taskId: string): Promise<AgentTask> {
    const response = await this.post<ApiResponse<AgentTask>>(
      `/agent/tasks/${taskId}/cancel`
    );
    return response.data;
  }

  // ============================================
  // Agent Framework
  // ============================================

  async executeFrameworkTask(input: FrameworkTaskRequest): Promise<FrameworkTaskResponse> {
    const response = await this.post<FrameworkTaskResponse>("/v1/framework/tasks", input);
    return response;
  }

  async getFrameworkTaskStatus(taskId: string): Promise<FrameworkTaskStatus> {
    const response = await this.get<FrameworkTaskStatus>(`/v1/framework/tasks/${taskId}`);
    return response;
  }

  async cancelFrameworkTask(taskId: string): Promise<{ success: boolean; taskId: string; status: string }> {
    const response = await this.post<{ success: boolean; taskId: string; status: string }>(
      `/v1/framework/tasks/${taskId}/cancel`,
      { action: 'cancel' }
    );
    return response;
  }

  async retryFrameworkTask(taskId: string): Promise<FrameworkTaskResponse> {
    const response = await this.post<FrameworkTaskResponse>(
      `/v1/framework/tasks/${taskId}/retry`
    );
    return response;
  }

  async getFrameworkResources(): Promise<FrameworkResourceStatus> {
    const response = await this.get<FrameworkResourceStatus>("/v1/framework/resources");
    return response;
  }

  async getFrameworkMetrics(): Promise<FrameworkMetrics> {
    const response = await this.get<FrameworkMetrics>("/v1/framework/metrics");
    return response;
  }

  async subscribeToFrameworkEvents(
    callback: (event: { type: string; taskId?: string; timestamp: string; data: any }) => void
  ): Promise<() => void> {
    const url = `${this.baseUrl}/v1/framework/events`;
    const eventSource = new EventSource(url, {
      headers: this.headers,
    } as EventSourceInit);

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        callback({
          type: data.type,
          taskId: data.taskId,
          timestamp: data.timestamp,
          data: data.data,
        });
      } catch (error) {
        console.error('[CodmirClient] Failed to parse framework event:', error);
      }
    };

    eventSource.addEventListener('message', handleMessage);
    eventSource.addEventListener('error', (error) => {
      console.error('[CodmirClient] Framework EventSource error:', error);
    });

    // Return unsubscribe function
    return () => {
      eventSource.removeEventListener('message', handleMessage);
      eventSource.close();
    };
  }

  async createFrameworkTaskStream(taskId: string): Promise<{
    subscribe: (callback: (event: any) => void) => void;
    unsubscribe: () => void;
    close: () => void;
  }> {
    let eventSource: EventSource | null = null;
    let callback: ((event: any) => void) | null = null;

    return {
      subscribe: (cb: (event: any) => void) => {
        callback = cb;
        eventSource = new EventSource(`${this.baseUrl}/v1/framework/tasks/${taskId}/stream`, {
          headers: this.headers,
        } as EventSourceInit);

        eventSource.addEventListener('message', (event) => {
          try {
            const data = JSON.parse(event.data);
            callback?.({
              type: data.type,
              taskId: data.taskId,
              stepId: data.stepId,
              timestamp: new Date(data.timestamp),
              data: data.data,
            });
          } catch (error) {
            console.error('[CodmirClient] Failed to parse framework stream event:', error);
          }
        });

        eventSource.addEventListener('error', (error) => {
          console.error('[CodmirClient] Framework stream error:', error);
        });
      },

      unsubscribe: () => {
        callback = null;
      },

      close: () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        callback = null;
      },
    };
  }

  // ============================================
  // AI Chat
  // ============================================

  async chat(
    message: string,
    options?: {
      projectId?: string;
      context?: Record<string, unknown>;
      model?: string;
    }
  ): Promise<string> {
    const response = await this.post<ApiResponse<{ response: string }>>(
      "/ai/chat",
      {
        message,
        ...options,
      }
    );
    return response.data.response;
  }

  async streamChat(
    message: string,
    options?: {
      projectId?: string;
      context?: Record<string, unknown>;
      model?: string;
      onChunk?: (chunk: string) => void;
    }
  ): Promise<string> {
    const url = `${this.baseUrl}/ai/chat/stream`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        message,
        projectId: options?.projectId,
        context: options?.context,
        model: options?.model,
      }),
    });

    if (!response.ok) {
      throw new CodmirApiError("STREAM_ERROR", "Failed to start stream", response.status);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new CodmirApiError("STREAM_ERROR", "No response body");
    }

    const decoder = new TextDecoder();
    let fullResponse = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      fullResponse += chunk;
      options?.onChunk?.(chunk);
    }

    return fullResponse;
  }
}

// Default export for convenience
export default CodmirClient;
