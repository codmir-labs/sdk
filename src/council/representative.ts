/**
 * @fileoverview
 * Representative - A party in the council
 * 
 * Representatives can be AI agents, humans, systems, or community voices.
 * Each representative has a vote and can participate in protocols.
 */

import type { Party, PartyType, RepresentativeConfig, Vote, VoteDecision } from './types';
import { THE_81_RULES } from './rules';

/**
 * Representative - A voting party in the council.
 * 
 * @example
 * ```typescript
 * const overseer = new Representative({
 *   id: 'ai:overseer',
 *   type: 'ai',
 *   name: 'Overseer',
 *   role: 'orchestrator',
 *   votingStrategy: 'balanced',
 * });
 * 
 * const vote = await overseer.deliberate({
 *   topic: 'Deploy to production',
 *   context: 'Code has passed all tests',
 * });
 * ```
 */
export class Representative implements Party {
  readonly id: string;
  readonly type: PartyType;
  readonly name: string;
  readonly role?: string;
  readonly capabilities?: string[];
  readonly voteWeight: number;

  private config: RepresentativeConfig;
  private systemPrompt: string;

  constructor(config: RepresentativeConfig) {
    this.id = config.id;
    this.type = config.type;
    this.name = config.name;
    this.role = config.role;
    this.capabilities = config.capabilities;
    this.voteWeight = config.voteWeight ?? 1;
    this.config = config;
    this.systemPrompt = config.systemPrompt || this.getDefaultPrompt();
  }

  /**
   * Deliberate on a topic and form a vote.
   * For AI representatives, this would call the AI model.
   * For humans, this returns a pending vote that must be filled.
   */
  async deliberate(params: {
    topic: string;
    context?: string;
    previousVotes?: Vote[];
    rulesContext?: number[];
  }): Promise<{
    decision: VoteDecision;
    confidence: number;
    reasoning: string;
    rulesCited: number[];
  }> {
    if (this.type === 'human') {
      // Human representatives must vote manually
      return {
        decision: 'abstain',
        confidence: 0,
        reasoning: 'Awaiting human input',
        rulesCited: [],
      };
    }

    // For AI/system representatives, simulate deliberation
    // In production, this would call the actual AI model
    const applicableRules = params.rulesContext || this.getRelevantRules(params.topic);
    
    const strategy = this.config.votingStrategy || 'balanced';
    let decision: VoteDecision;
    let confidence: number;

    switch (strategy) {
      case 'conservative':
        // Conservative: require high confidence to approve
        decision = params.previousVotes?.every(v => v.decision === 'approve') ? 'approve' : 'abstain';
        confidence = 0.6;
        break;
      case 'progressive':
        // Progressive: approve unless clear issues
        decision = params.previousVotes?.some(v => v.decision === 'reject') ? 'conditional' : 'approve';
        confidence = 0.8;
        break;
      case 'balanced':
      default:
        // Balanced: follow majority with moderate confidence
        const approves = params.previousVotes?.filter(v => v.decision === 'approve').length || 0;
        const rejects = params.previousVotes?.filter(v => v.decision === 'reject').length || 0;
        decision = approves > rejects ? 'approve' : rejects > approves ? 'reject' : 'abstain';
        confidence = 0.7;
    }

    return {
      decision,
      confidence,
      reasoning: `${this.name} deliberated on "${params.topic}" using ${strategy} strategy.`,
      rulesCited: applicableRules.slice(0, 3),
    };
  }

  /**
   * Get the party representation.
   */
  toParty(): Party {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      role: this.role,
      capabilities: this.capabilities,
      voteWeight: this.voteWeight,
    };
  }

  /**
   * Get the system prompt for AI deliberation.
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Check if this representative can auto-vote.
   */
  canAutoVote(): boolean {
    return this.config.autoVote ?? (this.type === 'ai' || this.type === 'system');
  }

  private getDefaultPrompt(): string {
    const prompts: Record<PartyType, string> = {
      ai: `You are ${this.name}, an AI representative in the Codmir Council.
Your role: ${this.role || 'Evaluate proposals and vote according to Grace Foundation principles.'}

When deliberating:
1. Consider the 81 Rules of the Grace Foundation
2. Weigh benefits against risks
3. Prioritize safety and reversibility
4. Be transparent in your reasoning
5. Cite specific rules that inform your decision

Vote options:
- approve: Proposal aligns with principles and is safe to proceed
- reject: Proposal violates principles or poses unacceptable risk
- conditional: Approve with specific conditions that must be met
- defer: Defer to another party's judgment
- abstain: Insufficient information to decide`,

      human: `You are a human representative in the Codmir Council.
Your vote carries the weight of human judgment and oversight.
Consider ethical implications that AI may miss.`,

      system: `You are a system representative enforcing technical constraints.
Vote based on system capabilities, resource availability, and technical feasibility.`,

      community: `You represent the community interest in the Codmir Council.
Consider impact on users, fairness across stakeholders, and long-term sustainability.`,
    };

    return prompts[this.type] || prompts.ai;
  }

  private getRelevantRules(topic: string): number[] {
    // Simple keyword matching for relevant rules
    const keywords = topic.toLowerCase().split(/\s+/);
    const relevant: number[] = [];

    for (const rule of THE_81_RULES) {
      const ruleText = `${rule.name} ${rule.statement}`.toLowerCase();
      if (keywords.some(kw => ruleText.includes(kw))) {
        relevant.push(rule.id);
      }
    }

    // Always include safety rules
    const safetyRules = THE_81_RULES.filter(r => r.aspect === 'safety').map(r => r.id);
    return [...new Set([...relevant, ...safetyRules])].slice(0, 10);
  }
}

/**
 * Create a representative.
 */
export function createRepresentative(config: RepresentativeConfig): Representative {
  return new Representative(config);
}

/**
 * Pre-defined AI representatives based on existing council agents.
 */
export const AI_REPRESENTATIVES = {
  overseer: () => createRepresentative({
    id: 'ai:overseer',
    type: 'ai',
    name: 'Overseer',
    role: 'orchestrator',
    capabilities: ['orchestration', 'triage', 'monitoring', 'escalation'],
    voteWeight: 2,
    votingStrategy: 'balanced',
  }),

  reviewer: () => createRepresentative({
    id: 'ai:reviewer',
    type: 'ai',
    name: 'Code Reviewer',
    role: 'reviewer',
    capabilities: ['code_review', 'pr_review', 'style_check', 'security_scan'],
    voteWeight: 1,
    votingStrategy: 'conservative',
  }),

  analyst: () => createRepresentative({
    id: 'ai:analyst',
    type: 'ai',
    name: 'Deep Analyst',
    role: 'analyst',
    capabilities: ['root_cause_analysis', 'pattern_detection', 'impact_analysis'],
    voteWeight: 1,
    votingStrategy: 'balanced',
  }),

  qa: () => createRepresentative({
    id: 'ai:qa',
    type: 'ai',
    name: 'QA Guardian',
    role: 'qa',
    capabilities: ['test_generation', 'test_execution', 'coverage_analysis'],
    voteWeight: 1,
    votingStrategy: 'conservative',
  }),

  fixer: () => createRepresentative({
    id: 'ai:fixer',
    type: 'ai',
    name: 'Rapid Fixer',
    role: 'fixer',
    capabilities: ['error_diagnosis', 'code_fix', 'hotfix', 'rollback'],
    voteWeight: 1,
    votingStrategy: 'progressive',
  }),

  planner: () => createRepresentative({
    id: 'ai:planner',
    type: 'ai',
    name: 'Strategic Planner',
    role: 'planner',
    capabilities: ['task_breakdown', 'estimation', 'dependency_analysis', 'risk_assessment'],
    voteWeight: 1,
    votingStrategy: 'balanced',
  }),

  arbiter: () => createRepresentative({
    id: 'ai:arbiter',
    type: 'ai',
    name: 'Final Arbiter',
    role: 'arbiter',
    capabilities: ['arbitration', 'conflict_resolution', 'consensus_building'],
    voteWeight: 3,
    votingStrategy: 'balanced',
  }),
};

/**
 * Create a human representative.
 */
export function humanRepresentative(id: string, name: string, role?: string): Representative {
  return createRepresentative({
    id: `human:${id}`,
    type: 'human',
    name,
    role: role || 'human overseer',
    voteWeight: 5, // Humans have higher weight
    autoVote: false,
  });
}

/**
 * Create a community representative.
 */
export function communityRepresentative(name: string): Representative {
  return createRepresentative({
    id: `community:${name.toLowerCase().replace(/\s+/g, '-')}`,
    type: 'community',
    name,
    role: 'community voice',
    voteWeight: 2,
    votingStrategy: 'balanced',
  });
}
