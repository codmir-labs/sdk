import type {
  BugReport,
  BugReportResult,
  CodmirReportConfig,
  EnvironmentInfo,
  SearchOptions,
  SearchResult,
  UpvoteResult,
} from './types'

const DEFAULT_BASE_URL = 'https://codmir.com/api/v1'
const DEFAULT_TIMEOUT = 15000

export class CodmirReport {
  private config: Required<Pick<CodmirReportConfig, 'projectKey' | 'baseUrl' | 'timeout' | 'autoSearch'>> & CodmirReportConfig

  constructor(config: CodmirReportConfig) {
    if (!config.projectKey) {
      throw new Error('@codmir/report: projectKey is required')
    }

    this.config = {
      ...config,
      baseUrl: (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
      timeout: config.timeout || DEFAULT_TIMEOUT,
      autoSearch: config.autoSearch ?? true,
    }
  }

  async reportBug(report: BugReport): Promise<BugReportResult> {
    if (this.config.beforeReport) {
      const modified = this.config.beforeReport(report)
      if (!modified) {
        throw new Error('@codmir/report: report blocked by beforeReport hook')
      }
      report = modified
    }

    if (this.config.autoSearch) {
      const existing = await this.searchBugs({
        vendor: report.vendor,
        query: report.title,
        limit: 3,
      })

      if (existing.reports.length > 0) {
        const match = existing.reports[0]
        await this.upvote(match.id)
        return {
          id: match.id,
          vendor: match.vendor,
          title: match.title,
          status: match.status,
          url: match.url,
          isDuplicate: true,
          duplicateOf: match.id,
        }
      }
    }

    const environment = typeof report.environment === 'object'
      ? formatEnvironment(report.environment)
      : report.environment

    const body = {
      vendor: report.vendor,
      title: report.title,
      description: report.description,
      severity: report.severity,
      repro_steps: report.reproSteps,
      expected_behavior: report.expectedBehavior,
      actual_behavior: report.actualBehavior,
      product: report.product,
      version: report.version,
      environment,
      category: report.category,
    }

    return this.request<BugReportResult>('POST', '/bugs/report', body)
  }

  async searchBugs(options: SearchOptions): Promise<SearchResult> {
    const params = new URLSearchParams()
    if (options.vendor) params.set('vendor', options.vendor)
    params.set('query', options.query)
    if (options.status) params.set('status', options.status)
    if (options.limit) params.set('limit', String(options.limit))

    return this.request<SearchResult>('GET', `/bugs/search?${params}`)
  }

  async upvote(reportId: string): Promise<UpvoteResult> {
    return this.request<UpvoteResult>('POST', `/bugs/${reportId}/upvote`)
  }

  async captureException(
    error: Error,
    context?: { vendor: string; product?: string; severity?: BugReport['severity'] }
  ): Promise<BugReportResult> {
    const vendor = context?.vendor || 'unknown'
    const stack = error.stack || ''
    const environment = detectEnvironment()

    return this.reportBug({
      vendor,
      title: `${error.name}: ${error.message}`,
      description: `Automatically captured exception.\n\n**Error:** ${error.message}\n\n**Stack trace:**\n\`\`\`\n${stack}\n\`\`\``,
      severity: context?.severity || 'MEDIUM',
      product: context?.product,
      actualBehavior: error.message,
      environment,
    })
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeout)

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.projectKey}`,
          'X-Codmir-SDK': '@codmir/report',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const error = new Error(`@codmir/report: ${response.status} ${response.statusText} — ${text}`)
        this.config.onError?.(error)
        throw error
      }

      const json = await response.json()
      return json.data ?? json
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        const error = new Error(`@codmir/report: request timed out after ${this.config.timeout}ms`)
        this.config.onError?.(error)
        throw error
      }
      if (err instanceof Error) {
        this.config.onError?.(err)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

function formatEnvironment(env: EnvironmentInfo): string {
  return Object.entries(env)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')
}

function detectEnvironment(): string {
  const parts: string[] = []

  if (typeof navigator !== 'undefined') {
    parts.push(`browser: ${navigator.userAgent}`)
  }

  if (typeof process !== 'undefined' && process.version) {
    parts.push(`node: ${process.version}`)
    if (process.platform) parts.push(`os: ${process.platform}`)
  }

  return parts.join(', ') || 'unknown'
}
