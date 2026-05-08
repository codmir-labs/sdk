/**
 * Integration Adapters for Codmir Agent SDK
 *
 * Export all integration adapters that connect the Agent SDK
 * with existing Codmir infrastructure.
 */

import { DatabaseAdapter } from './DatabaseAdapter'
import type { DatabaseAdapterConfig } from './DatabaseAdapter'
import { AuthAdapter } from './AuthAdapter'
import type { AuthAdapterConfig } from './AuthAdapter'
import { APIAdapter } from './APIAdapter'
import type { APIAdapterConfig } from './APIAdapter'
import { EventSystemAdapter } from './EventSystemAdapter'
import type { EventSystemAdapterConfig } from './EventSystemAdapter'

export { DatabaseAdapter, AuthAdapter, APIAdapter, EventSystemAdapter }
export type { DatabaseAdapterConfig, AuthAdapterConfig, APIAdapterConfig, EventSystemAdapterConfig }

// Factory function to create all adapters
export interface CreateAdaptersConfig {
  database?: DatabaseAdapterConfig
  auth?: AuthAdapterConfig
  api?: {
    engine: any
    authMiddleware?: any
    rateLimiter?: any
  }
  eventSystem?: {
    engine: any
    eventEngine: any
    externalEventEmitter?: any
    eventPrefix?: string
  }
}

export function createAdapters(config: CreateAdaptersConfig) {
  const adapters: any = {}

  if (config.database) {
    adapters.database = new DatabaseAdapter(config.database)
  }

  if (config.auth) {
    adapters.auth = new AuthAdapter(config.auth)
  }

  if (config.api) {
    adapters.api = new APIAdapter(config.api)
  }

  if (config.eventSystem) {
    adapters.eventSystem = new EventSystemAdapter(config.eventSystem)
  }

  return adapters
}
