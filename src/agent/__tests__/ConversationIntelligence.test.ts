/**
 * ConversationIntelligence Test Suite
 * 
 * Tests for conversation analysis and understanding capabilities
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals'
import { ConversationIntelligence } from '../intelligence/ConversationIntelligence'
import type { ConversationContext, ConversationAnalysis } from '../types'

describe('ConversationIntelligence', () => {
  let intelligence: ConversationIntelligence

  beforeEach(() => {
    intelligence = new ConversationIntelligence({
      maxContextLength: 10000,
      sentimentAnalysisEnabled: true,
      intentDetectionEnabled: true,
      topicExtractionEnabled: true
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('conversation analysis', () => {
    it('should analyze conversation context comprehensively', async () => {
      const conversation: ConversationContext = {
        id: 'conv-123',
        messages: [
          {
            id: '1',
            role: 'user',
            content: 'I need help implementing user authentication in my React app. It should support login with email/password and social providers like Google.',
            timestamp: new Date().toISOString()
          },
          {
            id: '2', 
            role: 'assistant',
            content: 'I can help you implement authentication! Let me suggest using NextAuth.js for a comprehensive solution.',
            timestamp: new Date().toISOString()
          },
          {
            id: '3',
            role: 'user', 
            content: 'That sounds great! Can you also add JWT token handling and refresh tokens?',
            timestamp: new Date().toISOString()
          }
        ],
        metadata: {
          projectId: 'proj-123',
          participantCount: 2
        }
      }

      const analysis = await intelligence.analyzeConversation({
        conversation,
        analysisDepth: 'comprehensive'
      })

      expect(analysis).toHaveProperty('intent')
      expect(analysis).toHaveProperty('sentiment')
      expect(analysis).toHaveProperty('complexity')
      expect(analysis).toHaveProperty('topics')
      expect(analysis).toHaveProperty('technologies')
      expect(analysis).toHaveProperty('requiresAction')
      expect(analysis).toHaveProperty('suggestedPriority')

      expect(analysis.intent).toBe('feature_request')
      expect(analysis.sentiment).toBe('positive')
      expect(analysis.topics).toContain('authentication')
      expect(analysis.technologies).toContain('React')
      expect(analysis.technologies).toContain('NextAuth')
      expect(analysis.requiresAction).toBe(true)
    })

    it('should detect conversation intent accurately', async () => {
      const testCases = [
        {
          messages: [{ role: 'user', content: 'There is a bug in the login form - users cannot submit credentials' }],
          expectedIntent: 'bug_report'
        },
        {
          messages: [{ role: 'user', content: 'How do I configure environment variables in Next.js?' }],
          expectedIntent: 'question'
        },
        {
          messages: [{ role: 'user', content: 'Please add a dark mode toggle to the header component' }],
          expectedIntent: 'feature_request'
        },
        {
          messages: [{ role: 'user', content: 'Let\'s discuss the architecture for the new messaging system' }],
          expectedIntent: 'discussion'
        }
      ]

      for (const testCase of testCases) {
        const conversation: ConversationContext = {
          id: `test-${testCase.expectedIntent}`,
          messages: testCase.messages.map((msg, idx) => ({
            id: idx.toString(),
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
            timestamp: new Date().toISOString()
          }))
        }

        const analysis = await intelligence.analyzeConversation({ conversation })
        expect(analysis.intent).toBe(testCase.expectedIntent)
      }
    })

    it('should assess conversation complexity', async () => {
      const simpleConversation: ConversationContext = {
        id: 'simple',
        messages: [
          { id: '1', role: 'user', content: 'Change button color to blue', timestamp: new Date().toISOString() }
        ]
      }

      const complexConversation: ConversationContext = {
        id: 'complex',
        messages: [
          {
            id: '1', 
            role: 'user', 
            content: 'I need to build a distributed microservices architecture with event sourcing, CQRS, and real-time data synchronization across multiple databases including PostgreSQL, Redis, and Elasticsearch. The system should handle millions of concurrent users with sub-100ms response times.',
            timestamp: new Date().toISOString()
          }
        ]
      }

      const simpleAnalysis = await intelligence.analyzeConversation({ 
        conversation: simpleConversation 
      })
      const complexAnalysis = await intelligence.analyzeConversation({ 
        conversation: complexConversation 
      })

      expect(simpleAnalysis.complexity).toBe('simple')
      expect(complexAnalysis.complexity).toBe('complex')
    })

    it('should perform sentiment analysis', async () => {
      const sentimentTests = [
        {
          content: 'This is amazing! I love how well this works. Great job!',
          expected: 'positive'
        },
        {
          content: 'This feature is broken and causing major issues. Very frustrated.',
          expected: 'negative'
        },
        {
          content: 'The API returns user data in JSON format.',
          expected: 'neutral'
        }
      ]

      for (const test of sentimentTests) {
        const conversation: ConversationContext = {
          id: 'sentiment-test',
          messages: [
            { id: '1', role: 'user', content: test.content, timestamp: new Date().toISOString() }
          ]
        }

        const analysis = await intelligence.analyzeConversation({ conversation })
        expect(analysis.sentiment).toBe(test.expected)
      }
    })

    it('should extract technical topics and technologies', async () => {
      const conversation: ConversationContext = {
        id: 'tech-extraction',
        messages: [
          {
            id: '1',
            role: 'user',
            content: 'I need to implement JWT authentication using Node.js and Express. The frontend is built with React and TypeScript, and we\'re using PostgreSQL for data storage.',
            timestamp: new Date().toISOString()
          }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ conversation })

      expect(analysis.topics).toContain('authentication')
      expect(analysis.technologies).toContain('Node')
      expect(analysis.technologies).toContain('Express')
      expect(analysis.technologies).toContain('React')
      expect(analysis.technologies).toContain('TypeScript')
      expect(analysis.technologies).toContain('PostgreSQL')
      expect(analysis.technologies).toContain('JWT')
    })
  })

  describe('conversation patterns', () => {
    it('should identify conversation patterns', async () => {
      const backAndForthConversation: ConversationContext = {
        id: 'pattern-test',
        messages: [
          { id: '1', role: 'user', content: 'How do I deploy to production?', timestamp: new Date().toISOString() },
          { id: '2', role: 'assistant', content: 'You can use our deployment pipeline.', timestamp: new Date().toISOString() },
          { id: '3', role: 'user', content: 'What about environment variables?', timestamp: new Date().toISOString() },
          { id: '4', role: 'assistant', content: 'Set them in your .env file.', timestamp: new Date().toISOString() },
          { id: '5', role: 'user', content: 'How do I handle secrets securely?', timestamp: new Date().toISOString() }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ 
        conversation: backAndForthConversation,
        includePatterns: true 
      })

      expect(analysis.conversationPattern).toBe('interactive_discussion')
      expect(analysis.messageFlow).toBe('alternating')
      expect(analysis.engagementLevel).toBe('high')
    })

    it('should detect monologue patterns', async () => {
      const monologue: ConversationContext = {
        id: 'monologue',
        messages: [
          { id: '1', role: 'user', content: 'First message', timestamp: new Date().toISOString() },
          { id: '2', role: 'user', content: 'Second message', timestamp: new Date().toISOString() },
          { id: '3', role: 'user', content: 'Third message', timestamp: new Date().toISOString() }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ 
        conversation: monologue,
        includePatterns: true 
      })

      expect(analysis.conversationPattern).toBe('monologue')
      expect(analysis.messageFlow).toBe('sequential')
    })

    it('should analyze conversation urgency', async () => {
      const urgentConversation: ConversationContext = {
        id: 'urgent',
        messages: [
          {
            id: '1',
            role: 'user',
            content: 'URGENT: Production is down! Users cannot login and we\'re losing revenue. Please help ASAP!',
            timestamp: new Date().toISOString()
          }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ conversation: urgentConversation })

      expect(analysis.urgency).toBe('critical')
      expect(analysis.suggestedPriority).toBe('URGENT')
    })
  })

  describe('context understanding', () => {
    it('should understand conversation context evolution', async () => {
      const conversation: ConversationContext = {
        id: 'context-evolution',
        messages: [
          { id: '1', role: 'user', content: 'I need help with CSS styling', timestamp: new Date().toISOString() },
          { id: '2', role: 'assistant', content: 'What specific styling are you working on?', timestamp: new Date().toISOString() },
          { id: '3', role: 'user', content: 'Making the header responsive', timestamp: new Date().toISOString() },
          { id: '4', role: 'assistant', content: 'Use flexbox or CSS Grid for responsive layouts', timestamp: new Date().toISOString() },
          { id: '5', role: 'user', content: 'Actually, can we use Tailwind CSS instead?', timestamp: new Date().toISOString() }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ 
        conversation,
        trackContextEvolution: true 
      })

      expect(analysis.contextShifts).toHaveLength(1)
      expect(analysis.contextShifts![0].from).toContain('CSS')
      expect(analysis.contextShifts![0].to).toContain('Tailwind')
      expect(analysis.finalContext).toContain('Tailwind CSS')
    })

    it('should identify knowledge gaps', async () => {
      const conversation: ConversationContext = {
        id: 'knowledge-gaps',
        messages: [
          { id: '1', role: 'user', content: 'I\'m new to React. How do I create components?', timestamp: new Date().toISOString() },
          { id: '2', role: 'user', content: 'Also, what are hooks? I don\'t understand useState', timestamp: new Date().toISOString() }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ 
        conversation,
        identifyKnowledgeGaps: true 
      })

      expect(analysis.knowledgeGaps).toContain('React basics')
      expect(analysis.knowledgeGaps).toContain('React Hooks')
      expect(analysis.experienceLevel).toBe('beginner')
    })

    it('should suggest conversation improvements', async () => {
      const vagueConversation: ConversationContext = {
        id: 'vague',
        messages: [
          { id: '1', role: 'user', content: 'It doesn\'t work', timestamp: new Date().toISOString() },
          { id: '2', role: 'assistant', content: 'What specifically isn\'t working?', timestamp: new Date().toISOString() },
          { id: '3', role: 'user', content: 'The thing we talked about before', timestamp: new Date().toISOString() }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ 
        conversation: vagueConversation,
        suggestImprovements: true 
      })

      expect(analysis.improvementSuggestions).toContain('Request more specific information')
      expect(analysis.clarityScore).toBeLessThan(0.5)
    })
  })

  describe('action recommendations', () => {
    it('should recommend appropriate actions based on conversation', async () => {
      const bugReportConversation: ConversationContext = {
        id: 'bug-report',
        messages: [
          {
            id: '1',
            role: 'user',
            content: 'The user profile page shows a 500 error when trying to update email address. This started happening after yesterday\'s deployment.',
            timestamp: new Date().toISOString()
          }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ conversation: bugReportConversation })

      expect(analysis.recommendedActions).toContain('create_bug_ticket')
      expect(analysis.recommendedActions).toContain('investigate_error_logs')
      expect(analysis.requiresAction).toBe(true)
    })

    it('should recommend ticket creation for features', async () => {
      const featureConversation: ConversationContext = {
        id: 'feature-request',
        messages: [
          {
            id: '1',
            role: 'user',
            content: 'We need to add export functionality to the reports page. Users should be able to export data as CSV and PDF.',
            timestamp: new Date().toISOString()
          }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ conversation: featureConversation })

      expect(analysis.recommendedActions).toContain('create_feature_ticket')
      expect(analysis.estimatedEffort).toBeGreaterThan(0)
    })

    it('should recommend follow-up questions for unclear requests', async () => {
      const unclearConversation: ConversationContext = {
        id: 'unclear',
        messages: [
          { id: '1', role: 'user', content: 'Make it better', timestamp: new Date().toISOString() }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ conversation: unclearConversation })

      expect(analysis.recommendedActions).toContain('ask_clarifying_questions')
      expect(analysis.suggestedQuestions).toHaveLength(greaterThan(0))
    })
  })

  describe('performance and scalability', () => {
    it('should handle large conversations efficiently', async () => {
      const largeConversation: ConversationContext = {
        id: 'large-conv',
        messages: Array(500).fill(0).map((_, i) => ({
          id: i.toString(),
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i + 1} content`,
          timestamp: new Date().toISOString()
        }))
      }

      const startTime = Date.now()
      const analysis = await intelligence.analyzeConversation({ conversation: largeConversation })
      const duration = Date.now() - startTime

      expect(analysis).toBeDefined()
      expect(duration).toBeLessThan(5000) // Should complete within 5 seconds
    })

    it('should truncate very long conversations', async () => {
      const veryLongConversation: ConversationContext = {
        id: 'very-long',
        messages: Array(2000).fill(0).map((_, i) => ({
          id: i.toString(),
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Very long message content that repeats and could cause memory issues if not handled properly`,
          timestamp: new Date().toISOString()
        }))
      }

      // Should not throw memory errors
      const analysis = await intelligence.analyzeConversation({ conversation: veryLongConversation })

      expect(analysis).toBeDefined()
      expect(analysis.messagesTruncated).toBe(true)
    })

    it('should cache analysis results', async () => {
      const conversation: ConversationContext = {
        id: 'cache-test',
        messages: [
          { id: '1', role: 'user', content: 'Test message', timestamp: new Date().toISOString() }
        ]
      }

      // First analysis
      const start1 = Date.now()
      await intelligence.analyzeConversation({ conversation })
      const duration1 = Date.now() - start1

      // Second analysis (should use cache)
      const start2 = Date.now()
      await intelligence.analyzeConversation({ conversation })
      const duration2 = Date.now() - start2

      expect(duration2).toBeLessThan(duration1 * 0.5) // Should be significantly faster
    })
  })

  describe('error handling', () => {
    it('should handle empty conversations', async () => {
      const emptyConversation: ConversationContext = {
        id: 'empty',
        messages: []
      }

      const analysis = await intelligence.analyzeConversation({ conversation: emptyConversation })

      expect(analysis.intent).toBe('unknown')
      expect(analysis.sentiment).toBe('neutral')
      expect(analysis.complexity).toBe('simple')
      expect(analysis.topics).toEqual([])
    })

    it('should handle malformed messages gracefully', async () => {
      const malformedConversation: ConversationContext = {
        id: 'malformed',
        messages: [
          { id: '1', role: 'user', content: '', timestamp: new Date().toISOString() }, // Empty content
          { id: '2', role: 'assistant' as any, content: null as any, timestamp: 'invalid-date' }, // Invalid data
          { id: '3', role: 'user', content: 'Valid message', timestamp: new Date().toISOString() }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ conversation: malformedConversation })

      expect(analysis).toBeDefined()
      expect(analysis.validMessagesProcessed).toBe(1) // Only the valid message
    })

    it('should handle analysis failures gracefully', async () => {
      // Mock a failure in sentiment analysis
      const originalAnalyzeSentiment = (intelligence as any).analyzeSentiment
      ;(intelligence as any).analyzeSentiment = jest.fn().mockRejectedValue(new Error('Analysis failed'))

      const conversation: ConversationContext = {
        id: 'analysis-failure',
        messages: [
          { id: '1', role: 'user', content: 'Test message', timestamp: new Date().toISOString() }
        ]
      }

      const analysis = await intelligence.analyzeConversation({ conversation })

      expect(analysis.sentiment).toBe('neutral') // Should fall back to neutral
      expect(analysis.analysisWarnings).toContain('Sentiment analysis failed')

      // Restore original method
      ;(intelligence as any).analyzeSentiment = originalAnalyzeSentiment
    })
  })
})
