/**
 * @fileoverview
 * Council - The governing body for AI-human agreements
 * 
 * The Council orchestrates protocols between parties,
 * enforces the 81 Rules, and maintains consensus.
 */

import type {
  CouncilConfig,
  ProtocolConfig,
  Party,
  CouncilSession,
  Consensus,
  Vote,
  RuleContext,
} from './types';
import { Protocol, createProtocol } from './protocol';
import { Representative, AI_REPRESENTATIVES, humanRepresentative } from './representative';
import { THE_81_RULES, SEEDS, Rules } from './rules';

/**
 * Council - The governing body for protocol agreements.
 * 
 * @example
 * ```typescript
 * const council = new Council({ name: 'Production Council' });
 * 
 * // Add representatives
 * council.addRepresentative(AI_REPRESENTATIVES.overseer());
 * council.addRepresentative(AI_REPRESENTATIVES.reviewer());
 * council.addRepresentative(humanRepresentative('admin', 'Admin'));
 * 
 * // Create and execute a protocol
 * const result = await council.convene({
 *   topic: 'Deploy feature X to production',
 *   context: 'execution',
 *   requiredVotes: 'majority',
 * });
 * ```
 */
export class Council {
  readonly name: string;
  readonly config: CouncilConfig;

  private representatives: Map<string, Representative> = new Map();
  private activeProtocols: Map<string, Protocol> = new Map();
  private sessionHistory: CouncilSession[] = [];

  constructor(config: CouncilConfig = {}) {
    this.name = config.name || 'Codmir Council';
    this.config = {
      defaultConsensusThreshold: 0.66,
      maxDiscussionRounds: 5,
      timeoutMs: 60000,
      enforceRules: true,
      graceEnabled: true,
      ...config,
    };
  }

  /**
   * Add a representative to the council.
   */
  addRepresentative(representative: Representative): void {
    this.representatives.set(representative.id, representative);
  }

  /**
   * Remove a representative from the council.
   */
  removeRepresentative(id: string): void {
    this.representatives.delete(id);
  }

  /**
   * Get all representatives.
   */
  getRepresentatives(): Representative[] {
    return Array.from(this.representatives.values());
  }

  /**
   * Convene a council session to decide on a topic.
   */
  async convene(params: {
    topic: string;
    description?: string;
    context?: RuleContext;
    requiredVotes?: ProtocolConfig['requiredVotes'];
    representatives?: string[];
    deadline?: string;
  }): Promise<{
    protocol: Protocol;
    consensus: Consensus;
    session: CouncilSession;
  }> {
    // Determine which representatives participate
    const participantIds = params.representatives || Array.from(this.representatives.keys());
    
    // Create protocol
    const protocol = createProtocol({
      topic: params.topic,
      description: params.description,
      parties: participantIds,
      requiredVotes: params.requiredVotes || 'majority',
      context: params.context || 'review',
      deadline: params.deadline,
      maxRounds: this.config.maxDiscussionRounds,
    });

    // Add parties to protocol
    for (const id of participantIds) {
      const rep = this.representatives.get(id);
      if (rep) {
        protocol.addParty(rep.toParty());
      }
    }

    this.activeProtocols.set(protocol.id, protocol);

    // Collect votes from auto-voting representatives
    const votes: Vote[] = [];
    for (const id of participantIds) {
      const rep = this.representatives.get(id);
      if (rep && rep.canAutoVote()) {
        const deliberation = await rep.deliberate({
          topic: params.topic,
          context: params.description,
          previousVotes: votes,
        });

        await protocol.vote(id, {
          decision: deliberation.decision,
          confidence: deliberation.confidence,
          reasoning: deliberation.reasoning,
          rulesCited: deliberation.rulesCited,
        });

        votes.push({
          partyId: id,
          decision: deliberation.decision,
          confidence: deliberation.confidence,
          reasoning: deliberation.reasoning,
          timestamp: new Date().toISOString(),
          rulesCited: deliberation.rulesCited,
        });
      }
    }

    // Resolve consensus
    const consensus = await protocol.resolve();
    const session = protocol.getSession();

    // Store in history
    this.sessionHistory.push(session);
    this.activeProtocols.delete(protocol.id);

    return { protocol, consensus, session };
  }

  /**
   * Create a protocol without automatic execution.
   */
  createProtocol(config: Omit<ProtocolConfig, 'parties'> & { representatives?: string[] }): Protocol {
    const participantIds = config.representatives || Array.from(this.representatives.keys());
    
    const protocol = createProtocol({
      ...config,
      parties: participantIds,
    });

    for (const id of participantIds) {
      const rep = this.representatives.get(id);
      if (rep) {
        protocol.addParty(rep.toParty());
      }
    }

    this.activeProtocols.set(protocol.id, protocol);
    return protocol;
  }

  /**
   * Get an active protocol by ID.
   */
  getProtocol(id: string): Protocol | undefined {
    return this.activeProtocols.get(id);
  }

  /**
   * Get session history.
   */
  getHistory(): CouncilSession[] {
    return [...this.sessionHistory];
  }

  /**
   * Check if a proposed action would violate rules.
   */
  checkRules(context: RuleContext, action: Parameters<typeof Rules.checkViolations>[1]): ReturnType<typeof Rules.checkViolations> {
    if (!this.config.enforceRules) {
      return { violated: [], warnings: [] };
    }
    return Rules.checkViolations(context, action);
  }

  /**
   * Get rules applicable to a context.
   */
  getRulesForContext(context: RuleContext) {
    return Rules.byContext(context);
  }

  /**
   * Get all 81 rules.
   */
  getRules() {
    return THE_81_RULES;
  }

  /**
   * Get the 5 seeds.
   */
  getSeeds() {
    return SEEDS;
  }

  /**
   * Quick approval check for simple decisions.
   */
  async quickApproval(topic: string, requiredApprovers: string[] = []): Promise<boolean> {
    const approvers = requiredApprovers.length > 0 
      ? requiredApprovers 
      : Array.from(this.representatives.keys()).slice(0, 3);

    const { consensus } = await this.convene({
      topic,
      requiredVotes: 'majority',
      representatives: approvers,
    });

    return consensus.reached && consensus.decision === 'approve';
  }

  /**
   * Emergency override - requires human.
   */
  async emergencyOverride(
    protocolId: string,
    decision: 'approve' | 'reject',
    humanId: string,
    reason: string
  ): Promise<Consensus> {
    const protocol = this.activeProtocols.get(protocolId);
    if (!protocol) {
      throw new Error(`Protocol ${protocolId} not found`);
    }

    // Log the emergency override
    protocol.discuss(`human:${humanId}`, `EMERGENCY OVERRIDE: ${reason}`);
    
    return protocol.humanOverride(decision, `human:${humanId}`);
  }
}

/**
 * Create a new council.
 */
export function createCouncil(config?: CouncilConfig): Council {
  return new Council(config);
}

/**
 * Create a default council with standard AI representatives.
 */
export function createDefaultCouncil(name?: string): Council {
  const council = new Council({ name: name || 'Default Council' });
  
  // Add standard AI representatives
  council.addRepresentative(AI_REPRESENTATIVES.overseer());
  council.addRepresentative(AI_REPRESENTATIVES.reviewer());
  council.addRepresentative(AI_REPRESENTATIVES.analyst());
  council.addRepresentative(AI_REPRESENTATIVES.qa());
  council.addRepresentative(AI_REPRESENTATIVES.planner());
  council.addRepresentative(AI_REPRESENTATIVES.arbiter());

  return council;
}

/**
 * Create a minimal council for quick decisions.
 */
export function createQuickCouncil(): Council {
  const council = new Council({ 
    name: 'Quick Council',
    maxDiscussionRounds: 1,
  });
  
  council.addRepresentative(AI_REPRESENTATIVES.overseer());
  council.addRepresentative(AI_REPRESENTATIVES.reviewer());

  return council;
}
