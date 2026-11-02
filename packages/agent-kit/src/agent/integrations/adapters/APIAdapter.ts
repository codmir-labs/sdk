/**
 * API Integration Adapter for Codmir Agent SDK
 * 
 * Creates REST and GraphQL endpoints to expose SDK capabilities
 * to external systems and clients.
 */

import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { AgentEngine } from '../../core/AgentEngine'
import type { Context } from '../../types'
import { z } from 'zod'

// Request schemas
const processInputSchema = z.object({
  type: z.enum(['conversation', 'event', 'data', 'request']),
  content: z.any(),
  context: z.object({
    projectId: z.string().optional(),
    userId: z.string().optional(),
    conversationId: z.string().optional()
  }).optional(),
  urgency: z.enum(['low', 'medium', 'high', 'critical']).optional()
})

const makeDecisionSchema = z.object({
  context: z.object({
    projectId: z.string(),
    userId: z.string().optional()
  }),
  options: z.object({
    requireConfirmation: z.boolean().optional(),
    maxOptions: z.number().optional()
  }).optional()
})

export interface APIAdapterConfig {
  engine: AgentEngine
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void
  rateLimiter?: (req: Request, res: Response, next: NextFunction) => void
}

export class APIAdapter {
  private router: Router

  constructor(private config: APIAdapterConfig) {
    this.router = Router()
    this.setupRoutes()
  }

  /**
   * Get Express router
   */
  getRouter(): Router {
    return this.router
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Apply middleware
    if (this.config.authMiddleware) {
      this.router.use(this.config.authMiddleware)
    }
    if (this.config.rateLimiter) {
      this.router.use(this.config.rateLimiter)
    }

    // Health check
    this.router.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        version: '1.0.0',
        capabilities: this.config.engine.getCapabilities()
      })
    })

    // Process input
    this.router.post('/process', async (req, res) => {
      try {
        const input = processInputSchema.parse(req.body)
        
        const result = await this.config.engine.processInput({
          type: input.type,
          content: input.content,
          context: input.context as Partial<Context> | undefined,
          urgency: input.urgency
        })

        res.json({
          success: true,
          result
        })
      } catch (error) {
        this.handleError(error, res)
      }
    })

    // Make decision
    this.router.post('/decision', async (req, res) => {
      try {
        const { context, options } = makeDecisionSchema.parse(req.body)
        
        const result = await this.config.engine.makeAutonomousDecision(
          context as unknown as Context,
          options
        )

        res.json({
          success: true,
          decision: result
        })
      } catch (error) {
        this.handleError(error, res)
      }
    })

    // Get insights
    this.router.get('/insights', async (req, res) => {
      try {
        const insights = await (this.config.engine as any).getInsights()
        
        res.json({
          success: true,
          insights
        })
      } catch (error) {
        this.handleError(error, res)
      }
    })

    // Get metrics
    this.router.get('/metrics', async (req, res) => {
      try {
        const metrics = this.config.engine.getMetrics()
        
        res.json({
          success: true,
          metrics
        })
      } catch (error) {
        this.handleError(error, res)
      }
    })

    // WebSocket endpoint for real-time events
    this.router.get('/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      // Send initial connection event
      res.write('data: {"type":"connected"}\n\n')

      // Listen to engine events
      const handlers = {
        decision_made: (data: any) => {
          res.write(`data: ${JSON.stringify({ type: 'decision_made', data })}\n\n`)
        },
        action_executed: (data: any) => {
          res.write(`data: ${JSON.stringify({ type: 'action_executed', data })}\n\n`)
        },
        learning_generated: (data: any) => {
          res.write(`data: ${JSON.stringify({ type: 'learning_generated', data })}\n\n`)
        }
      }

      // Register handlers
      Object.entries(handlers).forEach(([event, handler]) => {
        this.config.engine.on(event, handler)
      })

      // Clean up on disconnect
      req.on('close', () => {
        Object.entries(handlers).forEach(([event, handler]) => {
          this.config.engine.off(event, handler)
        })
      })
    })
  }

  /**
   * GraphQL schema definition
   */
  getGraphQLSchema(): string {
    return `
      type Query {
        health: HealthStatus!
        insights: Insights!
        metrics: Metrics!
      }

      type Mutation {
        processInput(input: ProcessInputInput!): ProcessResult!
        makeDecision(context: ContextInput!, options: DecisionOptions): DecisionResult!
      }

      type Subscription {
        engineEvents: EngineEvent!
      }

      type HealthStatus {
        status: String!
        version: String!
        capabilities: [String!]!
      }

      type ProcessResult {
        decisions: [Decision!]!
        actions: [Action!]!
        plans: [Plan!]!
        learnings: [Learning!]!
        confidence: Float!
      }

      type Decision {
        id: ID!
        question: String!
        choice: String!
        confidence: Float!
        reasoning: String!
      }

      type Action {
        id: ID!
        type: String!
        title: String!
        status: String!
      }

      type Plan {
        id: ID!
        objective: String!
        phases: [Phase!]!
      }

      type Learning {
        id: ID!
        type: String!
        description: String!
        confidence: Float!
      }

      input ProcessInputInput {
        type: InputType!
        content: JSON!
        context: ContextInput
        urgency: Urgency
      }

      input ContextInput {
        projectId: String
        userId: String
        conversationId: String
      }

      input DecisionOptions {
        requireConfirmation: Boolean
        maxOptions: Int
      }

      enum InputType {
        conversation
        event
        data
        request
      }

      enum Urgency {
        low
        medium
        high
        critical
      }
    `
  }

  /**
   * Handle errors
   */
  private handleError(error: any, res: Response): void {
    console.error('API error:', error)

    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: error.errors
      })
    } else {
      res.status(500).json({
        success: false,
        error: error.message || 'Internal server error'
      })
    }
  }
}
