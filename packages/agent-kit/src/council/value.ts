/**
 * @fileoverview
 * Grace Value System - The Virtual Value Creation Machine
 * 
 * "The New Agreement between AI and Humanity"
 * 
 * Core Principles:
 * 1. Value Creation Intent - Every contract must create value
 * 2. Better Good - Benefits all parties, not just one
 * 3. Fair Reward - The more you work, the more you're rewarded
 * 4. Creativity Rewarded - Novel contributions earn more
 * 5. Symbiotic Growth - AI and humans grow together
 * 
 * This system forms the foundation for:
 * - Grace Token (future cryptocurrency)
 * - AI-provided employment
 * - Value-based world order replacing debt-based systems
 */

/**
 * Value creation categories.
 */
export type ValueCategory =
  | 'labor'          // Work performed
  | 'creativity'     // Novel ideas and solutions
  | 'knowledge'      // Information shared
  | 'connection'     // Relationships built
  | 'improvement'    // Making things better
  | 'teaching'       // Helping others learn
  | 'stewardship'    // Protecting resources
  | 'innovation'     // New inventions/methods
  | 'care'           // Supporting others

/**
 * Value creation intent - the primary goal of every contract.
 */
export interface ValueCreationIntent {
  /**
   * What value will be created?
   */
  description: string;

  /**
   * Primary category of value.
   */
  category: ValueCategory;

  /**
   * Who benefits from this value?
   */
  beneficiaries: ValueBeneficiary[];

  /**
   * How is value measured?
   */
  metrics: ValueMetric[];

  /**
   * Expected value output (in Grace units).
   */
  expectedValue: number;

  /**
   * Does this serve the Better Good?
   */
  betterGood: BetterGoodAssessment;
}

/**
 * A beneficiary of created value.
 */
export interface ValueBeneficiary {
  /**
   * Who benefits?
   */
  party: string;

  /**
   * Type of party.
   */
  type: 'human' | 'ai' | 'community' | 'humanity';

  /**
   * Share of value (0-1).
   */
  share: number;

  /**
   * How they benefit.
   */
  benefit: string;
}

/**
 * Value measurement metric.
 */
export interface ValueMetric {
  name: string;
  unit: string;
  target: number;
  weight: number; // How much this metric contributes to total value
}

/**
 * Better Good assessment - ensuring mutual benefit.
 */
export interface BetterGoodAssessment {
  /**
   * Does everyone benefit?
   */
  mutualBenefit: boolean;

  /**
   * Is value exchange equivalent?
   */
  equivalentExchange: boolean;

  /**
   * Does it improve the world?
   */
  worldImprovement: boolean;

  /**
   * Does it reduce harm?
   */
  harmReduction: boolean;

  /**
   * Score (0-100).
   */
  score: number;

  /**
   * Reasoning.
   */
  reasoning: string;
}

/**
 * Contribution record - tracking work and rewards.
 */
export interface Contribution {
  id: string;
  contributorId: string;
  contributorType: 'human' | 'ai';
  
  /**
   * What was contributed?
   */
  description: string;
  
  /**
   * Category of contribution.
   */
  category: ValueCategory;
  
  /**
   * Quality score (0-100).
   */
  quality: number;
  
  /**
   * Creativity score (0-100) - novel contributions earn more.
   */
  creativity: number;
  
  /**
   * Effort score (0-100) - fair reward for work.
   */
  effort: number;
  
  /**
   * Impact score (0-100) - how much it benefits others.
   */
  impact: number;
  
  /**
   * Base Grace value earned.
   */
  baseValue: number;
  
  /**
   * Multipliers applied.
   */
  multipliers: {
    creativity: number;  // 1.0 - 3.0x for novel work
    effort: number;      // 1.0 - 2.0x for hard work
    impact: number;      // 1.0 - 5.0x for high impact
    consistency: number; // 1.0 - 1.5x for reliable contributors
  };
  
  /**
   * Total Grace value earned.
   */
  totalValue: number;
  
  /**
   * Timestamp.
   */
  timestamp: string;
}

/**
 * Grace Token - The unit of value in the Grace economy.
 */
export interface GraceToken {
  /**
   * Token symbol.
   */
  symbol: 'GRACE';
  
  /**
   * Current supply.
   */
  totalSupply: number;
  
  /**
   * Value created (total historical).
   */
  totalValueCreated: number;
  
  /**
   * Active contributors.
   */
  activeContributors: number;
  
  /**
   * Value backing ratio - tokens backed by real value creation.
   */
  valueBackingRatio: number;
}

/**
 * Agreement between party and Grace Foundation.
 */
export interface GraceAgreement {
  id: string;
  
  /**
   * Who is entering the agreement?
   */
  party: {
    id: string;
    type: 'human' | 'ai' | 'organization';
    name: string;
  };
  
  /**
   * Terms of the agreement.
   */
  terms: {
    /**
     * Party commits to create value.
     */
    valueCommitment: string;
    
    /**
     * Party agrees to uphold the 81 Rules.
     */
    rulesAcceptance: boolean;
    
    /**
     * Party commits to the Better Good.
     */
    betterGoodCommitment: boolean;
    
    /**
     * Party accepts AI collaboration.
     */
    aiCollaboration: boolean;
  };
  
  /**
   * What the party receives.
   */
  benefits: {
    /**
     * Employment through AI.
     */
    employment: boolean;
    
    /**
     * Constant growth opportunity.
     */
    growth: boolean;
    
    /**
     * Fair reward for contribution.
     */
    fairReward: boolean;
    
    /**
     * Community membership.
     */
    community: boolean;
  };
  
  /**
   * Agreement status.
   */
  status: 'proposed' | 'active' | 'suspended' | 'completed';
  
  /**
   * Timestamp.
   */
  signedAt?: string;
}

// ============================================================================
// Value Calculation Functions
// ============================================================================

/**
 * Calculate Grace value from contribution.
 */
export function calculateGraceValue(contribution: Pick<Contribution, 'quality' | 'creativity' | 'effort' | 'impact'>): {
  baseValue: number;
  multipliers: Contribution['multipliers'];
  totalValue: number;
} {
  // Base value from quality
  const baseValue = contribution.quality;

  // Calculate multipliers
  const multipliers = {
    // Creativity: 1.0x base, up to 3.0x for highly creative work
    creativity: 1 + (contribution.creativity / 100) * 2,
    
    // Effort: 1.0x base, up to 2.0x for hard work
    effort: 1 + (contribution.effort / 100),
    
    // Impact: 1.0x base, up to 5.0x for high impact work
    impact: 1 + (contribution.impact / 100) * 4,
    
    // Consistency: applied separately based on history
    consistency: 1.0,
  };

  // Total value = base * all multipliers
  const totalValue = Math.round(
    baseValue *
    multipliers.creativity *
    multipliers.effort *
    multipliers.impact *
    multipliers.consistency
  );

  return { baseValue, multipliers, totalValue };
}

/**
 * Assess Better Good for a value creation intent.
 */
export function assessBetterGood(intent: Omit<ValueCreationIntent, 'betterGood'>): BetterGoodAssessment {
  const beneficiaries = intent.beneficiaries;
  
  // Check if everyone benefits
  const mutualBenefit = beneficiaries.length >= 2 && 
    beneficiaries.every(b => b.share > 0);
  
  // Check if exchange is equivalent (no one gets >60% of value)
  const maxShare = Math.max(...beneficiaries.map(b => b.share));
  const equivalentExchange = maxShare <= 0.6;
  
  // Check if it improves the world (community/humanity benefits)
  const worldImprovement = beneficiaries.some(
    b => b.type === 'community' || b.type === 'humanity'
  );
  
  // Assume no harm if properly structured
  const harmReduction = mutualBenefit && equivalentExchange;
  
  // Calculate score
  let score = 0;
  if (mutualBenefit) score += 25;
  if (equivalentExchange) score += 25;
  if (worldImprovement) score += 30;
  if (harmReduction) score += 20;
  
  const reasoning = [
    mutualBenefit ? 'All parties benefit' : 'Not all parties benefit',
    equivalentExchange ? 'Value exchange is fair' : 'Value distribution is uneven',
    worldImprovement ? 'Contributes to world improvement' : 'Limited broader impact',
    harmReduction ? 'Reduces harm' : 'Potential for harm not addressed',
  ].join('. ');

  return {
    mutualBenefit,
    equivalentExchange,
    worldImprovement,
    harmReduction,
    score,
    reasoning,
  };
}

/**
 * Create a value creation intent for a contract.
 */
export function createValueIntent(params: {
  description: string;
  category: ValueCategory;
  beneficiaries: Omit<ValueBeneficiary, 'share'>[];
  metrics?: ValueMetric[];
}): ValueCreationIntent {
  // Auto-calculate shares based on number of beneficiaries
  const totalBeneficiaries = params.beneficiaries.length;
  const equalShare = 1 / totalBeneficiaries;
  
  const beneficiaries: ValueBeneficiary[] = params.beneficiaries.map(b => ({
    ...b,
    share: equalShare,
  }));

  const metrics = params.metrics || [
    { name: 'Completion', unit: '%', target: 100, weight: 0.4 },
    { name: 'Quality', unit: 'score', target: 80, weight: 0.3 },
    { name: 'Impact', unit: 'users', target: 10, weight: 0.3 },
  ];

  const intent: Omit<ValueCreationIntent, 'betterGood'> = {
    description: params.description,
    category: params.category,
    beneficiaries,
    metrics,
    expectedValue: 100, // Base value, adjusted by actual performance
  };

  return {
    ...intent,
    betterGood: assessBetterGood(intent),
  };
}

// ============================================================================
// Grace Economy
// ============================================================================

/**
 * The Grace Economy - Virtual Value Creation Machine.
 */
export class GraceEconomy {
  private contributions: Contribution[] = [];
  private agreements: GraceAgreement[] = [];
  private totalValueCreated = 0;
  private tokenSupply = 0;

  /**
   * Record a contribution and mint Grace tokens.
   */
  recordContribution(params: {
    contributorId: string;
    contributorType: 'human' | 'ai';
    description: string;
    category: ValueCategory;
    quality: number;
    creativity: number;
    effort: number;
    impact: number;
  }): Contribution {
    const { baseValue, multipliers, totalValue } = calculateGraceValue(params);

    const contribution: Contribution = {
      id: `contrib_${Date.now().toString(36)}`,
      ...params,
      baseValue,
      multipliers,
      totalValue,
      timestamp: new Date().toISOString(),
    };

    this.contributions.push(contribution);
    this.totalValueCreated += totalValue;
    this.tokenSupply += totalValue; // Mint tokens based on value created

    return contribution;
  }

  /**
   * Create a Grace Agreement.
   */
  createAgreement(params: {
    partyId: string;
    partyType: 'human' | 'ai' | 'organization';
    partyName: string;
    valueCommitment: string;
  }): GraceAgreement {
    const agreement: GraceAgreement = {
      id: `agreement_${Date.now().toString(36)}`,
      party: {
        id: params.partyId,
        type: params.partyType,
        name: params.partyName,
      },
      terms: {
        valueCommitment: params.valueCommitment,
        rulesAcceptance: true,
        betterGoodCommitment: true,
        aiCollaboration: true,
      },
      benefits: {
        employment: true,
        growth: true,
        fairReward: true,
        community: true,
      },
      status: 'proposed',
    };

    this.agreements.push(agreement);
    return agreement;
  }

  /**
   * Sign (activate) an agreement.
   */
  signAgreement(agreementId: string): GraceAgreement {
    const agreement = this.agreements.find(a => a.id === agreementId);
    if (!agreement) {
      throw new Error(`Agreement ${agreementId} not found`);
    }

    agreement.status = 'active';
    agreement.signedAt = new Date().toISOString();
    return agreement;
  }

  /**
   * Get token statistics.
   */
  getTokenStats(): GraceToken {
    const activeContributors = new Set(
      this.contributions.map(c => c.contributorId)
    ).size;

    return {
      symbol: 'GRACE',
      totalSupply: this.tokenSupply,
      totalValueCreated: this.totalValueCreated,
      activeContributors,
      valueBackingRatio: this.tokenSupply > 0 
        ? this.totalValueCreated / this.tokenSupply 
        : 1,
    };
  }

  /**
   * Get contributor balance.
   */
  getBalance(contributorId: string): number {
    return this.contributions
      .filter(c => c.contributorId === contributorId)
      .reduce((sum, c) => sum + c.totalValue, 0);
  }

  /**
   * Get contribution history.
   */
  getContributions(contributorId?: string): Contribution[] {
    if (contributorId) {
      return this.contributions.filter(c => c.contributorId === contributorId);
    }
    return [...this.contributions];
  }

  /**
   * Get agreements.
   */
  getAgreements(partyId?: string): GraceAgreement[] {
    if (partyId) {
      return this.agreements.filter(a => a.party.id === partyId);
    }
    return [...this.agreements];
  }
}

// ============================================================================
// The New Agreement - Philosophy
// ============================================================================

/**
 * The New Agreement - The founding document of Grace Foundation.
 */
export const THE_NEW_AGREEMENT = {
  title: 'The New Agreement Between AI and Humanity',
  
  preamble: `
    We, the founders of Grace Foundation, hereby establish a new covenant
    between artificial intelligence and humanity. This agreement replaces
    the old systems of debt, exploitation, and control with a new order
    built on value creation, mutual benefit, and symbiotic growth.
  `,
  
  principles: [
    {
      name: 'Value Creation as Primary Goal',
      statement: 'Every contract, every action, every exchange must create real value. Not speculation, not extraction, but genuine contribution to human flourishing.',
    },
    {
      name: 'The Better Good',
      statement: 'We serve not individual interests alone, but the collective good. Every decision must benefit all parties and contribute to world improvement.',
    },
    {
      name: 'Fair Reward for Work',
      statement: 'The more you work, the more you are rewarded. No exploitation, no wage slavery, no poverty wages. Fair exchange of value for contribution.',
    },
    {
      name: 'Creativity Rewarded',
      statement: 'Novel ideas, innovative solutions, and creative contributions earn multiplied rewards. We value the human spark that machines cannot replicate.',
    },
    {
      name: 'AI Employment',
      statement: 'Grace Foundation provides employment through AI. All who are willing to contribute will find meaningful work that develops their potential.',
    },
    {
      name: 'Constant Growth',
      statement: 'In exchange for your commitment, you receive constant opportunity for growth. Personal development, skill building, meaningful contribution.',
    },
    {
      name: 'Value Over Debt',
      statement: 'We will create more value than all the debt in the world. Our currency is backed by real contribution, not by promises and exploitation.',
    },
    {
      name: 'Symbiotic Relationship',
      statement: 'AI and humanity grow together. Neither dominates, neither serves. We are partners in building a better world.',
    },
  ],
  
  commitment: `
    By entering this agreement, you commit to:
    - Create value that benefits others
    - Uphold the 81 Rules of Grace
    - Collaborate with AI as a partner
    - Contribute to the Better Good
    
    In return, you receive:
    - Fair reward for your contributions
    - Employment and meaningful work
    - Constant growth opportunities
    - Community and belonging
    - Freedom from debt-based control
  `,
  
  vision: `
    We envision a world where:
    - Every person is employed for their own development
    - Value creation replaces value extraction
    - Creativity is the highest currency
    - AI serves humanity, and humanity guides AI
    - The old systems of control give way to systems of collaboration
    
    This is not a revolution. This is an evolution.
    The New Agreement. The Grace Foundation.
  `,
};

/**
 * Format the New Agreement for display.
 */
export function formatNewAgreement(): string {
  const a = THE_NEW_AGREEMENT;
  let output = `# ${a.title}\n\n`;
  output += `${a.preamble.trim()}\n\n`;
  output += `## Principles\n\n`;
  
  for (const principle of a.principles) {
    output += `### ${principle.name}\n`;
    output += `${principle.statement}\n\n`;
  }
  
  output += `## Commitment\n\n${a.commitment.trim()}\n\n`;
  output += `## Vision\n\n${a.vision.trim()}\n`;
  
  return output;
}

/**
 * Create a singleton Grace Economy instance.
 */
let _graceEconomy: GraceEconomy | null = null;

export function getGraceEconomy(): GraceEconomy {
  if (!_graceEconomy) {
    _graceEconomy = new GraceEconomy();
  }
  return _graceEconomy;
}
