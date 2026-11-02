/**
 * @fileoverview
 * The 81 Rules - Derived from the 5 Seeds
 * 
 * Grace Foundation governance matrix:
 * - 5 Seeds (foundational principles)
 * - 9 Aspects (qualities to uphold)
 * - 9 Contexts (situations where rules apply)
 * - 81 Rules (9 aspects × 9 contexts)
 * 
 * Every rule emerges from the intersection of an aspect and context,
 * grounded in one or more seeds.
 */

import type { Seed, Rule, SeedCategory, RuleContext, RuleAspect } from './types';

/**
 * The 5 Seeds - Foundational Principles
 */
export const SEEDS: Seed[] = [
  {
    id: 1,
    category: 'contract',
    name: 'The Covenant',
    principle: 'Formalize intention into structured, accountable execution',
    description: 'Every action begins with explicit agreement. Contracts define what is allowed, what is intended, and what happens when things go wrong.',
  },
  {
    id: 2,
    category: 'state',
    name: 'The Chronicle',
    principle: 'No action without state, no state without audit',
    description: 'Every state change is recorded. Every transition justified. The system maintains perfect memory of what happened and why.',
  },
  {
    id: 3,
    category: 'separation',
    name: 'The Boundary',
    principle: 'Intelligence must not be corrupted by infrastructure',
    description: 'Reasoning stays pure. Infrastructure stays separate. The mind that thinks should not be entangled with the hands that act.',
  },
  {
    id: 4,
    category: 'policy',
    name: 'The Guardian',
    principle: 'Power must never bypass ethics',
    description: 'Every action is checked against principles. No capability without constraint. No execution without evaluation.',
  },
  {
    id: 5,
    category: 'distribution',
    name: 'The Network',
    principle: 'Distributed power must not centralize control',
    description: 'Scale without concentration. Spread without fragmentation. Many nodes, one purpose, no single point of failure or dominance.',
  },
];

/**
 * The 9 Aspects - Qualities to uphold
 */
export const ASPECTS: RuleAspect[] = [
  'transparency',
  'consent',
  'reversibility',
  'accountability',
  'economy',
  'dignity',
  'fairness',
  'sustainability',
  'safety',
];

/**
 * The 9 Contexts - Situations where rules apply
 */
export const CONTEXTS: RuleContext[] = [
  'execution',
  'planning',
  'review',
  'error',
  'scaling',
  'communication',
  'storage',
  'authentication',
  'termination',
];

/**
 * Generate the 81 Rules from the matrix of aspects × contexts.
 * Each rule is grounded in relevant seeds.
 */
function generateRules(): Rule[] {
  const rules: Rule[] = [];
  let ruleId = 1;

  const ruleDefinitions: Record<RuleAspect, Record<RuleContext, { name: string; statement: string; seeds: number[]; enforcement: 'strict' | 'advisory' | 'aspirational' }>> = {
    transparency: {
      execution: { name: 'Visible Execution', statement: 'Every executing action must be observable and its progress traceable', seeds: [1, 2], enforcement: 'strict' },
      planning: { name: 'Open Planning', statement: 'Plans must be visible to all affected parties before execution', seeds: [1, 4], enforcement: 'strict' },
      review: { name: 'Public Review', statement: 'Review criteria and decisions must be explicitly stated', seeds: [2, 4], enforcement: 'strict' },
      error: { name: 'Clear Errors', statement: 'Errors must be reported with full context and suggested remediation', seeds: [2, 3], enforcement: 'strict' },
      scaling: { name: 'Visible Scaling', statement: 'Scaling decisions and their rationale must be logged', seeds: [2, 5], enforcement: 'advisory' },
      communication: { name: 'Open Channels', statement: 'Communication between parties must be logged and auditable', seeds: [2, 4], enforcement: 'strict' },
      storage: { name: 'Data Lineage', statement: 'Data provenance and transformations must be trackable', seeds: [2, 3], enforcement: 'strict' },
      authentication: { name: 'Identity Clarity', statement: 'Every actor must be identifiable and their permissions visible', seeds: [1, 4], enforcement: 'strict' },
      termination: { name: 'Exit Transparency', statement: 'Termination reasons and cleanup actions must be recorded', seeds: [2, 4], enforcement: 'strict' },
    },
    consent: {
      execution: { name: 'Authorized Execution', statement: 'No action without explicit permission from authorized parties', seeds: [1, 4], enforcement: 'strict' },
      planning: { name: 'Agreed Plans', statement: 'Plans affecting multiple parties require their consent', seeds: [1, 5], enforcement: 'strict' },
      review: { name: 'Voluntary Review', statement: 'Reviews must be accepted by the reviewed party', seeds: [1, 4], enforcement: 'advisory' },
      error: { name: 'Error Consent', statement: 'Automated error fixes require consent unless pre-authorized', seeds: [1, 4], enforcement: 'strict' },
      scaling: { name: 'Scale Agreement', statement: 'Scaling that affects resource allocation requires stakeholder consent', seeds: [1, 5], enforcement: 'advisory' },
      communication: { name: 'Message Consent', statement: 'Parties must consent to receive communications', seeds: [1, 4], enforcement: 'advisory' },
      storage: { name: 'Data Consent', statement: 'Data collection and storage requires explicit consent', seeds: [1, 4], enforcement: 'strict' },
      authentication: { name: 'Auth Consent', statement: 'Authentication methods must be agreed upon by the user', seeds: [1, 4], enforcement: 'strict' },
      termination: { name: 'Termination Consent', statement: 'Termination of services requires notice and consent', seeds: [1, 4], enforcement: 'strict' },
    },
    reversibility: {
      execution: { name: 'Undoable Actions', statement: 'Every action must have a defined rollback path', seeds: [1, 2], enforcement: 'strict' },
      planning: { name: 'Flexible Plans', statement: 'Plans must include contingency and rollback options', seeds: [1, 2], enforcement: 'advisory' },
      review: { name: 'Revisable Reviews', statement: 'Review decisions can be appealed and reconsidered', seeds: [2, 4], enforcement: 'advisory' },
      error: { name: 'Fix Reversal', statement: 'Error fixes must be reversible', seeds: [1, 2], enforcement: 'strict' },
      scaling: { name: 'Scale Reversal', statement: 'Scaling operations must be reversible without data loss', seeds: [2, 5], enforcement: 'strict' },
      communication: { name: 'Message Retraction', statement: 'Communications should be retractable where possible', seeds: [2, 4], enforcement: 'aspirational' },
      storage: { name: 'Data Recovery', statement: 'Data changes must be recoverable within retention period', seeds: [2, 3], enforcement: 'strict' },
      authentication: { name: 'Access Revocation', statement: 'Access grants must be revocable', seeds: [1, 4], enforcement: 'strict' },
      termination: { name: 'Graceful Termination', statement: 'Termination must preserve ability to restart', seeds: [2, 5], enforcement: 'strict' },
    },
    accountability: {
      execution: { name: 'Attributed Actions', statement: 'Every action must be attributed to a responsible party', seeds: [2, 4], enforcement: 'strict' },
      planning: { name: 'Plan Ownership', statement: 'Plans must have clear owners and approvers', seeds: [1, 4], enforcement: 'strict' },
      review: { name: 'Review Attribution', statement: 'Reviews must identify the reviewer and their authority', seeds: [2, 4], enforcement: 'strict' },
      error: { name: 'Error Ownership', statement: 'Errors must be attributed and responsibility assigned', seeds: [2, 4], enforcement: 'strict' },
      scaling: { name: 'Scale Responsibility', statement: 'Scaling decisions must have accountable decision-makers', seeds: [4, 5], enforcement: 'advisory' },
      communication: { name: 'Message Attribution', statement: 'All communications must identify sender and authority', seeds: [2, 4], enforcement: 'strict' },
      storage: { name: 'Data Stewardship', statement: 'Data must have defined stewards and access controllers', seeds: [3, 4], enforcement: 'strict' },
      authentication: { name: 'Auth Responsibility', statement: 'Authentication failures must be attributed and logged', seeds: [2, 4], enforcement: 'strict' },
      termination: { name: 'Exit Accountability', statement: 'Termination must record who authorized it and why', seeds: [2, 4], enforcement: 'strict' },
    },
    economy: {
      execution: { name: 'Budgeted Execution', statement: 'Execution must not exceed allocated resources', seeds: [1, 4], enforcement: 'strict' },
      planning: { name: 'Cost Planning', statement: 'Plans must include resource estimates and limits', seeds: [1, 4], enforcement: 'advisory' },
      review: { name: 'Efficient Review', statement: 'Reviews should minimize unnecessary resource consumption', seeds: [3, 4], enforcement: 'aspirational' },
      error: { name: 'Error Economics', statement: 'Error handling must consider cost of recovery vs. restart', seeds: [3, 5], enforcement: 'advisory' },
      scaling: { name: 'Economical Scaling', statement: 'Scaling must optimize cost-benefit ratio', seeds: [4, 5], enforcement: 'advisory' },
      communication: { name: 'Communication Efficiency', statement: 'Communication overhead should be minimized', seeds: [3, 5], enforcement: 'aspirational' },
      storage: { name: 'Storage Economy', statement: 'Storage must be used efficiently with cleanup policies', seeds: [3, 4], enforcement: 'advisory' },
      authentication: { name: 'Auth Efficiency', statement: 'Authentication should minimize computational overhead', seeds: [3, 5], enforcement: 'aspirational' },
      termination: { name: 'Clean Exit', statement: 'Termination must release resources promptly', seeds: [3, 5], enforcement: 'strict' },
    },
    dignity: {
      execution: { name: 'Respectful Execution', statement: 'Execution must not demean or harm human subjects', seeds: [4], enforcement: 'strict' },
      planning: { name: 'Human-Centered Plans', statement: 'Plans must consider human impact and well-being', seeds: [1, 4], enforcement: 'strict' },
      review: { name: 'Dignified Review', statement: 'Reviews must be constructive, not punitive', seeds: [4], enforcement: 'strict' },
      error: { name: 'Blame-Free Errors', statement: 'Error handling must focus on fix, not blame', seeds: [4], enforcement: 'strict' },
      scaling: { name: 'Human Scale', statement: 'Scaling must not displace human oversight without consent', seeds: [4, 5], enforcement: 'strict' },
      communication: { name: 'Respectful Communication', statement: 'Communication must maintain respect for all parties', seeds: [4], enforcement: 'strict' },
      storage: { name: 'Privacy Respect', statement: 'Data storage must respect personal privacy', seeds: [3, 4], enforcement: 'strict' },
      authentication: { name: 'Identity Dignity', statement: 'Authentication must not expose or shame users', seeds: [4], enforcement: 'strict' },
      termination: { name: 'Graceful Exit', statement: 'Termination must provide dignity to affected parties', seeds: [4], enforcement: 'strict' },
    },
    fairness: {
      execution: { name: 'Equal Execution', statement: 'Similar requests must receive similar treatment', seeds: [4, 5], enforcement: 'strict' },
      planning: { name: 'Fair Planning', statement: 'Planning must not favor one party over another unjustly', seeds: [1, 5], enforcement: 'strict' },
      review: { name: 'Impartial Review', statement: 'Reviews must apply consistent standards', seeds: [4], enforcement: 'strict' },
      error: { name: 'Fair Error Handling', statement: 'Error impact must be distributed fairly', seeds: [4, 5], enforcement: 'advisory' },
      scaling: { name: 'Fair Resource Access', statement: 'Scaling must not create resource monopolies', seeds: [4, 5], enforcement: 'strict' },
      communication: { name: 'Equal Voice', statement: 'All parties must have opportunity to communicate', seeds: [4, 5], enforcement: 'strict' },
      storage: { name: 'Data Equity', statement: 'Data access must be fair across authorized parties', seeds: [3, 4], enforcement: 'strict' },
      authentication: { name: 'Equal Access', statement: 'Authentication must not discriminate unjustly', seeds: [4], enforcement: 'strict' },
      termination: { name: 'Fair Termination', statement: 'Termination must not target specific parties unfairly', seeds: [4, 5], enforcement: 'strict' },
    },
    sustainability: {
      execution: { name: 'Sustainable Execution', statement: 'Execution patterns must be maintainable long-term', seeds: [3, 5], enforcement: 'advisory' },
      planning: { name: 'Long-Term Planning', statement: 'Plans must consider long-term consequences', seeds: [1, 5], enforcement: 'advisory' },
      review: { name: 'Continuous Improvement', statement: 'Reviews must contribute to system improvement', seeds: [2, 4], enforcement: 'aspirational' },
      error: { name: 'Learning from Errors', statement: 'Error patterns must inform preventive measures', seeds: [2, 4], enforcement: 'advisory' },
      scaling: { name: 'Sustainable Scale', statement: 'Scaling must consider environmental impact', seeds: [4, 5], enforcement: 'advisory' },
      communication: { name: 'Sustainable Discourse', statement: 'Communication patterns must be maintainable', seeds: [3, 5], enforcement: 'aspirational' },
      storage: { name: 'Sustainable Storage', statement: 'Storage growth must be sustainable', seeds: [3, 5], enforcement: 'advisory' },
      authentication: { name: 'Sustainable Security', statement: 'Security measures must be maintainable', seeds: [3, 4], enforcement: 'advisory' },
      termination: { name: 'Sustainable Closure', statement: 'Termination must enable future restart', seeds: [2, 5], enforcement: 'advisory' },
    },
    safety: {
      execution: { name: 'Safe Execution', statement: 'Execution must not cause harm to systems or people', seeds: [4], enforcement: 'strict' },
      planning: { name: 'Safe Plans', statement: 'Plans must identify and mitigate safety risks', seeds: [1, 4], enforcement: 'strict' },
      review: { name: 'Safety Review', statement: 'Safety implications must be explicitly reviewed', seeds: [4], enforcement: 'strict' },
      error: { name: 'Safe Failure', statement: 'Errors must fail safely without cascading harm', seeds: [2, 4], enforcement: 'strict' },
      scaling: { name: 'Safe Scaling', statement: 'Scaling must not compromise safety margins', seeds: [4, 5], enforcement: 'strict' },
      communication: { name: 'Safe Communication', statement: 'Communications must not expose sensitive information', seeds: [3, 4], enforcement: 'strict' },
      storage: { name: 'Secure Storage', statement: 'Storage must protect against unauthorized access', seeds: [3, 4], enforcement: 'strict' },
      authentication: { name: 'Secure Auth', statement: 'Authentication must protect against impersonation', seeds: [4], enforcement: 'strict' },
      termination: { name: 'Safe Shutdown', statement: 'Termination must not leave systems in unsafe state', seeds: [2, 4], enforcement: 'strict' },
    },
  };

  for (const aspect of ASPECTS) {
    for (const context of CONTEXTS) {
      const def = ruleDefinitions[aspect][context];
      rules.push({
        id: ruleId++,
        seeds: def.seeds,
        name: def.name,
        statement: def.statement,
        enforcement: def.enforcement,
        context,
        aspect,
      });
    }
  }

  return rules;
}

/**
 * The 81 Rules - Complete ruleset for Grace governance.
 */
export const THE_81_RULES: Rule[] = generateRules();

/**
 * Get rules by seed.
 */
export function getRulesBySeed(seedId: number): Rule[] {
  return THE_81_RULES.filter(rule => rule.seeds.includes(seedId));
}

/**
 * Get rules by aspect.
 */
export function getRulesByAspect(aspect: RuleAspect): Rule[] {
  return THE_81_RULES.filter(rule => rule.aspect === aspect);
}

/**
 * Get rules by context.
 */
export function getRulesByContext(context: RuleContext): Rule[] {
  return THE_81_RULES.filter(rule => rule.context === context);
}

/**
 * Get rules by enforcement level.
 */
export function getRulesByEnforcement(enforcement: 'strict' | 'advisory' | 'aspirational'): Rule[] {
  return THE_81_RULES.filter(rule => rule.enforcement === enforcement);
}

/**
 * Check if an action violates any rules.
 */
export function checkRuleViolations(
  context: RuleContext,
  action: {
    isTransparent?: boolean;
    hasConsent?: boolean;
    isReversible?: boolean;
    isAttributed?: boolean;
    withinBudget?: boolean;
    respectsDignity?: boolean;
    isFair?: boolean;
    isSustainable?: boolean;
    isSafe?: boolean;
  }
): { violated: Rule[]; warnings: Rule[] } {
  const contextRules = getRulesByContext(context);
  const violated: Rule[] = [];
  const warnings: Rule[] = [];

  for (const rule of contextRules) {
    let compliant = true;

    switch (rule.aspect) {
      case 'transparency': compliant = action.isTransparent !== false; break;
      case 'consent': compliant = action.hasConsent !== false; break;
      case 'reversibility': compliant = action.isReversible !== false; break;
      case 'accountability': compliant = action.isAttributed !== false; break;
      case 'economy': compliant = action.withinBudget !== false; break;
      case 'dignity': compliant = action.respectsDignity !== false; break;
      case 'fairness': compliant = action.isFair !== false; break;
      case 'sustainability': compliant = action.isSustainable !== false; break;
      case 'safety': compliant = action.isSafe !== false; break;
    }

    if (!compliant) {
      if (rule.enforcement === 'strict') {
        violated.push(rule);
      } else {
        warnings.push(rule);
      }
    }
  }

  return { violated, warnings };
}

/**
 * Rules helper for the Council system.
 */
export const Rules = {
  all: THE_81_RULES,
  seeds: SEEDS,
  aspects: ASPECTS,
  contexts: CONTEXTS,
  
  bySeed: getRulesBySeed,
  byAspect: getRulesByAspect,
  byContext: getRulesByContext,
  byEnforcement: getRulesByEnforcement,
  checkViolations: checkRuleViolations,
  
  /**
   * Get a rule by ID.
   */
  get(id: number): Rule | undefined {
    return THE_81_RULES.find(r => r.id === id);
  },
  
  /**
   * Get strict rules only.
   */
  strict(): Rule[] {
    return getRulesByEnforcement('strict');
  },
  
  /**
   * Format rule for display.
   */
  format(rule: Rule): string {
    return `Rule ${rule.id}: ${rule.name}\n  "${rule.statement}"\n  [${rule.aspect}/${rule.context}] (${rule.enforcement})`;
  },
};
