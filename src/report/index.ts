import { CodmirReport } from './client'
import type {
  BugReport,
  BugReportResult,
  CodmirReportConfig,
  SearchOptions,
  Severity,
} from './types'

export { CodmirReport }
export type {
  BugReport,
  BugReportResult,
  BugStatus,
  CodmirReportConfig,
  EnvironmentInfo,
  SearchOptions,
  SearchResult,
  Severity,
  UpvoteResult,
  VendorCategory,
} from './types'

let _instance: CodmirReport | null = null

function getInstance(): CodmirReport {
  if (!_instance) {
    throw new Error('@codmir/sdk/report: call Codmir.init({ projectKey: "..." }) before using the SDK')
  }
  return _instance
}

export const Codmir = {
  init(config: CodmirReportConfig) {
    _instance = new CodmirReport(config)
  },

  async reportBug(report: BugReport): Promise<BugReportResult> {
    return getInstance().reportBug(report)
  },

  async searchBugs(options: SearchOptions) {
    return getInstance().searchBugs(options)
  },

  async upvote(reportId: string) {
    return getInstance().upvote(reportId)
  },

  async captureException(
    error: Error,
    context?: { vendor: string; product?: string; severity?: Severity }
  ): Promise<BugReportResult> {
    return getInstance().captureException(error, context)
  },
}
