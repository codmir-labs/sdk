export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export type BugStatus = 'OPEN' | 'TRIAGED' | 'CONFIRMED' | 'IN_PROGRESS' | 'FIXED' | 'CLOSED' | 'WONT_FIX' | 'DUPLICATE'

export type VendorCategory =
  | 'DEVELOPER_TOOLS' | 'SAAS' | 'FINTECH' | 'AI_ML'
  | 'CLOUD' | 'DEVOPS' | 'DESIGN' | 'COMMUNICATION'
  | 'SECURITY' | 'OTHER'

export interface BugReport {
  vendor: string
  title: string
  description: string
  severity: Severity
  reproSteps?: string
  expectedBehavior?: string
  actualBehavior?: string
  product?: string
  version?: string
  environment?: string | EnvironmentInfo
  category?: VendorCategory
}

export interface EnvironmentInfo {
  os?: string
  browser?: string
  runtime?: string
  nodeVersion?: string
  sdkVersion?: string
  [key: string]: string | undefined
}

export interface BugReportResult {
  id: string
  vendor: string
  title: string
  status: BugStatus
  url: string
  isDuplicate: boolean
  duplicateOf?: string
}

export interface SearchOptions {
  vendor?: string
  query: string
  status?: BugStatus
  limit?: number
}

export interface SearchResult {
  reports: Array<{
    id: string
    vendor: string
    title: string
    status: BugStatus
    severity: Severity
    upvotes: number
    url: string
    createdAt: string
  }>
  total: number
}

export interface UpvoteResult {
  id: string
  upvotes: number
}

export interface CodmirReportConfig {
  projectKey: string
  baseUrl?: string
  timeout?: number
  autoSearch?: boolean
  onError?: (error: Error) => void
  beforeReport?: (report: BugReport) => BugReport | null
}
