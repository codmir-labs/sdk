/**
 * @fileoverview
 * Grace Integration - Connect Council with Grace Foundation
 * 
 * Bridges the Council voting system with Grace policy enforcement,
 * the 5 seeds, and the engine/runtime execution layer.
 */

import type { 
  Consensus, 
  RuleContext, 
  Rule,
  CouncilSession,
} from './types';
import { THE_81_RULES, SEEDS, Rules } from './rules';
import { Council, createDefaultCouncil } from './council';

/**
 * Grace action assessment result.
 */
export interface GraceAssessment {
  allowed: boolean;
  requiresCouncil: boolean;
  riskScore: number;
  rulesApplicable: Rule[];
  rulesViolated: Rule[];
  recommendations: string[];
}

/**
 * Grace execution context.
 */
export interface GraceExecutionContext {
  contractId?: string;
  runId?: string;
  actorId: string;
  actorType: 'ai' | 'human' | 'system';
  action: string;
  context: RuleContext;
  impactLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  reversible: boolean;
  budgetImpact?: number;
}

/**
 * Grace Integration - Connect Council with Grace Foundation governance.
 */
export class GraceIntegration {
  private council: Council;
  private assessmentHistory: GraceAssessment[] = [];
  private autoApproveThreshold = 20; // Risk score below this auto-approves

  constructor(council?: Council) {
    this.council = council || createDefaultCouncil('Grace Council');
  }

  /**
   * Assess an action against Grace principles.
   */
  assess(context: GraceExecutionContext): GraceAssessment {
    const applicableRules = Rules.byContext(context.context);
    const riskScore = this.calculateRiskScore(context);
    
    // Check rule violations
    const violations = Rules.checkViolations(context.context, {
      isTransparent: true,
      hasConsent: context.actorType === 'human' || riskScore < 30,
      isReversible: context.reversible,
      isAttributed: !!context.actorId,
      withinBudget: !context.budgetImpact || context.budgetImpact < 100,
      respectsDignity: true,
      isFair: true,
      isSustainable: true,
      isSafe: context.impactLevel !== 'critical',
    });

    const recommendations = this.generateRecommendations(context, violations);

    const assessment: GraceAssessment = {
      allowed: violations.violated.length === 0,
      requiresCouncil: riskScore >= 50 || violations.violated.length > 0,
      riskScore,
      rulesApplicable: applicableRules,
      rulesViolated: violations.violated,
      recommendations,
    };

    this.assessmentHistory.push(assessment);
    return assessment;
  }

  /**
   * Request Council approval for an action.
   */
  async requestApproval(context: GraceExecutionContext): Promise<{
    approved: boolean;
    consensus: Consensus;
    session: CouncilSession;
  }> {
    const assessment = this.assess(context);

    // Auto-approve low-risk actions
    if (assessment.riskScore < this.autoApproveThreshold && assessment.allowed) {
      return {
        approved: true,
        consensus: {
          reached: true,
          decision: 'approve',
          votes: [],
          requiresHumanOverride: false,
          rulesApplied: assessment.rulesApplicable.map(r => r.id),
          confidence: 1,
        },
        session: {
          id: `auto_${Date.now()}`,
          protocol: { topic: context.action, parties: [], requiredVotes: 'majority' },
          parties: [],
          votes: [],
          discussion: [],
          status: 'consensus',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      };
    }

    // Convene council for higher-risk actions
    const { consensus, session } = await this.council.convene({
      topic: `${context.action} (Risk: ${assessment.riskScore})`,
      description: this.formatContextDescription(context),
      context: context.context,
      requiredVotes: assessment.riskScore >= 70 ? 'supermajority' : 'majority',
    });

    return {
      approved: consensus.reached && consensus.decision === 'approve',
      consensus,
      session,
    };
  }

  /**
   * Enforce Grace rules before execution.
   */
  async enforce(
    context: GraceExecutionContext,
    execute: () => Promise<void>
  ): Promise<{
    executed: boolean;
    assessment: GraceAssessment;
    approval?: { consensus: Consensus; session: CouncilSession };
  }> {
    const assessment = this.assess(context);

    // Critical violations block execution
    if (assessment.rulesViolated.some(r => r.enforcement === 'strict')) {
      return {
        executed: false,
        assessment,
      };
    }

    // High risk requires council
    if (assessment.requiresCouncil) {
      const approval = await this.requestApproval(context);
      
      if (!approval.approved) {
        return {
          executed: false,
          assessment,
          approval: { consensus: approval.consensus, session: approval.session },
        };
      }

      // Execute with approval
      await execute();
      return {
        executed: true,
        assessment,
        approval: { consensus: approval.consensus, session: approval.session },
      };
    }

    // Low risk executes directly
    await execute();
    return {
      executed: true,
      assessment,
    };
  }

  /**
   * Get the underlying council.
   */
  getCouncil(): Council {
    return this.council;
  }

  /**
   * Get assessment history.
   */
  getHistory(): GraceAssessment[] {
    return [...this.assessmentHistory];
  }

  /**
   * Set auto-approve threshold.
   */
  setAutoApproveThreshold(threshold: number): void {
    this.autoApproveThreshold = Math.max(0, Math.min(100, threshold));
  }

  /**
   * Get the 5 Seeds.
   */
  getSeeds() {
    return SEEDS;
  }

  /**
   * Get the 81 Rules.
   */
  getRules() {
    return THE_81_RULES;
  }

  /**
   * Format rules for display.
   */
  formatRules(): string {
    let output = '# The 81 Rules of Grace\n\n';
    output += '## The 5 Seeds\n\n';
    
    for (const seed of SEEDS) {
      output += `### Seed ${seed.id}: ${seed.name}\n`;
      output += `**Principle:** ${seed.principle}\n`;
      output += `${seed.description}\n\n`;
    }

    output += '## The 81 Rules\n\n';
    
    for (const rule of THE_81_RULES) {
      output += `**Rule ${rule.id}: ${rule.name}**\n`;
      output += `"${rule.statement}"\n`;
      output += `[${rule.aspect}/${rule.context}] (${rule.enforcement})\n`;
      output += `Seeds: ${rule.seeds.join(', ')}\n\n`;
    }

    return output;
  }

  private calculateRiskScore(context: GraceExecutionContext): number {
    let score = 0;

    // Impact level contribution
    const impactScores = {
      safe: 0,
      low: 15,
      medium: 35,
      high: 60,
      critical: 90,
    };
    score += impactScores[context.impactLevel];

    // Reversibility
    if (!context.reversible) {
      score += 20;
    }

    // Actor type
    if (context.actorType === 'ai') {
      score += 10; // AI actions need more scrutiny
    }

    // Budget impact
    if (context.budgetImpact) {
      if (context.budgetImpact > 100) score += 20;
      else if (context.budgetImpact > 50) score += 10;
      else if (context.budgetImpact > 10) score += 5;
    }

    // Context-specific risks
    const contextRisks: Record<RuleContext, number> = {
      execution: 5,
      planning: 0,
      review: 0,
      error: 10,
      scaling: 15,
      communication: 5,
      storage: 10,
      authentication: 20,
      termination: 25,
    };
    score += contextRisks[context.context] || 0;

    return Math.min(100, score);
  }

  private generateRecommendations(
    context: GraceExecutionContext,
    violations: { violated: Rule[]; warnings: Rule[] }
  ): string[] {
    const recommendations: string[] = [];

    if (!context.reversible) {
      recommendations.push('Consider making this action reversible by creating a snapshot first.');
    }

    if (context.impactLevel === 'high' || context.impactLevel === 'critical') {
      recommendations.push('Request human oversight for high-impact actions.');
    }

    if (context.actorType === 'ai' && context.context === 'authentication') {
      recommendations.push('AI should not handle authentication without human approval.');
    }

    for (const rule of violations.violated) {
      recommendations.push(`Address violation of Rule ${rule.id}: ${rule.name}`);
    }

    for (const rule of violations.warnings) {
      recommendations.push(`Consider Rule ${rule.id}: ${rule.statement}`);
    }

    return recommendations;
  }

  private formatContextDescription(context: GraceExecutionContext): string {
    return `
Action: ${context.action}
Context: ${context.context}
Actor: ${context.actorId} (${context.actorType})
Impact Level: ${context.impactLevel}
Reversible: ${context.reversible}
${context.budgetImpact ? `Budget Impact: ${context.budgetImpact} credits` : ''}
${context.contractId ? `Contract: ${context.contractId}` : ''}
${context.runId ? `Run: ${context.runId}` : ''}
    `.trim();
  }
}

/**
 * Create Grace integration with default council.
 */
export function createGraceIntegration(council?: Council): GraceIntegration {
  return new GraceIntegration(council);
}

/**
 * Quick Grace check for simple actions.
 */
export async function graceCheck(
  action: string,
  context: RuleContext = 'execution',
  impactLevel: GraceExecutionContext['impactLevel'] = 'low'
): Promise<boolean> {
  const grace = new GraceIntegration();
  const { approved } = await grace.requestApproval({
    actorId: 'system',
    actorType: 'system',
    action,
    context,
    impactLevel,
    reversible: true,
  });
  return approved;
}
