/**
 * Authentication Integration Adapter for Codmir Agent SDK
 * 
 * Integrates with the existing auth system to provide user context
 * and permission checking for autonomous actions.
 */

import type { Session } from 'next-auth'
import type { Context } from '../../types'

type UserContext = Context['user']

export interface AuthAdapterConfig {
  getSession: () => Promise<Session | null>
  checkPermission?: (userId: string, action: string) => Promise<boolean>
}

export class AuthAdapter {
  constructor(private config: AuthAdapterConfig) {}

  /**
   * Get current user context from auth session
   */
  async getCurrentUserContext(): Promise<UserContext | undefined> {
    const session = await this.config.getSession()
    
    if (!session?.user) {
      return undefined
    }

    const user = session.user as any

    return {
      id: user.id,
      role: user.role || 'developer',
      expertise: user.expertise || ['general'],
      preferences: {
        communicationStyle: user.preferences?.communicationStyle || 'concise',
        workingStyle: user.preferences?.workingStyle || 'autonomous',
        notificationPrefs: user.preferences?.notificationPrefs || [],
        toolPreferences: user.preferences?.toolPreferences || []
      },
      workingHours: [],
      currentFocus: [],
      recentActivity: []
    } as UserContext
  }

  /**
   * Check if user has permission for an action
   */
  async checkPermission(userId: string, action: string): Promise<boolean> {
    if (!this.config.checkPermission) {
      // Default to true if no permission checker provided
      return true
    }

    return this.config.checkPermission(userId, action)
  }

  /**
   * Enhance context with auth information
   */
  async enhanceContextWithAuth(context: Partial<Context>): Promise<Context> {
    const userContext = await this.getCurrentUserContext()
    
    return {
      ...context,
      user: context.user || userContext,
      system: {
        ...context.system,
        authenticated: !!userContext,
        userId: userContext?.id
      }
    } as Context
  }

  /**
   * Get permission level for autonomous actions
   */
  async getAutonomyPermissions(userId: string): Promise<{
    canCreateTickets: boolean
    canCreateTasks: boolean
    canModifyCode: boolean
    canDeployCode: boolean
    canAccessSensitiveData: boolean
    maxAutonomyLevel: 'conservative' | 'balanced' | 'aggressive'
  }> {
    // Check individual permissions
    const [
      canCreateTickets,
      canCreateTasks,
      canModifyCode,
      canDeployCode,
      canAccessSensitiveData
    ] = await Promise.all([
      this.checkPermission(userId, 'tickets.create'),
      this.checkPermission(userId, 'tasks.create'),
      this.checkPermission(userId, 'code.modify'),
      this.checkPermission(userId, 'code.deploy'),
      this.checkPermission(userId, 'data.sensitive')
    ])

    // Determine max autonomy level based on permissions
    let maxAutonomyLevel: 'conservative' | 'balanced' | 'aggressive' = 'conservative'
    
    if (canDeployCode && canAccessSensitiveData) {
      maxAutonomyLevel = 'aggressive'
    } else if (canModifyCode && canCreateTasks) {
      maxAutonomyLevel = 'balanced'
    }

    return {
      canCreateTickets,
      canCreateTasks,
      canModifyCode,
      canDeployCode,
      canAccessSensitiveData,
      maxAutonomyLevel
    }
  }
}
