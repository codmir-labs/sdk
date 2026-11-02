/**
 * @fileoverview
 * Protocol - Agreement system between parties
 * 
 * A protocol is a constant creation of agreement.
 * All involved parties vote, and consensus emerges from collective decision.
 */

import type {
  ProtocolConfig,
  Vote,
  VoteDecision,
  Consensus,
  Party,
  CouncilSession,
  DiscussionMessage,
  ProtocolEvent,
  RuleContext,
} from './types';
import { THE_81_RULES, getRulesByContext, checkRuleViolations } from './rules';

/**
 * Protocol - An agreement between parties.
 * 
 * @example
 * ```typescript
 * const protocol = new Protocol({
 *   topic: 'Deploy to production',
 *   parties: ['ai:overseer', 'ai:reviewer', 'human:admin'],
 *   requiredVotes: 'majority',
 * });
 * 
 * await protocol.vote('ai:overseer', { decision: 'approve', reasoning: '...' });
 * const result = await protocol.resolve();
 * ```
 */
export class Protocol {
  readonly id: string;
  readonly config: ProtocolConfig;
  
  private parties: Map<string, Party> = new Map();
  private votes: Map<string, Vote> = new Map();
  private discussion: DiscussionMessage[] = [];
  private status: CouncilSession['status'] = 'forming';
  private round = 0;
  private eventListeners: Array<(event: ProtocolEvent) => void> = [];
  private startedAt: string;
  private endedAt?: string;

  constructor(config: ProtocolConfig) {
    this.id = config.id || `protocol_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.config = {
      allowConditional: true,
      allowDefer: true,
      maxRounds: 5,
      ...config,
    };
    this.startedAt = new Date().toISOString();

    this.emit({ type: 'created', protocol: this.config });
  }

  /**
   * Add a party to the protocol.
   */
  addParty(party: Party): void {
    this.parties.set(party.id, party);
    this.emit({ type: 'party_joined', partyId: party.id });
  }

  /**
   * Get all parties.
   */
  getParties(): Party[] {
    return Array.from(this.parties.values());
  }

  /**
   * Cast a vote.
   */
  async vote(
    partyId: string,
    voteData: {
      decision: VoteDecision;
      confidence?: number;
      reasoning: string;
      conditions?: string[];
      deferTo?: string;
      rulesCited?: number[];
    }
  ): Promise<void> {
    const party = this.parties.get(partyId);
    if (!party) {
      throw new Error(`Party ${partyId} is not part of this protocol`);
    }

    if (voteData.decision === 'conditional' && !this.config.allowConditional) {
      throw new Error('Conditional votes not allowed in this protocol');
    }

    if (voteData.decision === 'defer' && !this.config.allowDefer) {
      throw new Error('Defer votes not allowed in this protocol');
    }

    const previousVote = this.votes.get(partyId);
    const vote: Vote = {
      partyId,
      decision: voteData.decision,
      confidence: voteData.confidence ?? 0.8,
      reasoning: voteData.reasoning,
      conditions: voteData.conditions,
      deferTo: voteData.deferTo,
      timestamp: new Date().toISOString(),
      rulesCited: voteData.rulesCited,
    };

    this.votes.set(partyId, vote);
    this.status = 'voting';

    if (previousVote) {
      this.emit({ type: 'vote_changed', vote, previousDecision: previousVote.decision });
    } else {
      this.emit({ type: 'vote_cast', vote });
    }
  }

  /**
   * Add a discussion message.
   */
  discuss(partyId: string, content: string, replyTo?: string): void {
    const message: DiscussionMessage = {
      id: `msg_${Date.now().toString(36)}`,
      partyId,
      content,
      replyTo,
      timestamp: new Date().toISOString(),
      round: this.round,
    };

    this.discussion.push(message);
    this.status = 'discussing';
    this.emit({ type: 'discussion', message });
  }

  /**
   * Start a new discussion round.
   */
  nextRound(): boolean {
    if (this.round >= (this.config.maxRounds || 5)) {
      return false;
    }
    this.round++;
    return true;
  }

  /**
   * Resolve the protocol to consensus.
   */
  async resolve(): Promise<Consensus> {
    const votes = Array.from(this.votes.values());
    const required = this.getRequiredVotes();
    
    // Handle deferred votes
    const resolvedVotes = this.resolveDeferredVotes(votes);
    
    // Count decisions
    const counts = {
      approve: 0,
      reject: 0,
      abstain: 0,
      conditional: 0,
    };

    let totalWeight = 0;
    let approveWeight = 0;
    let rejectWeight = 0;

    for (const vote of resolvedVotes) {
      const party = this.parties.get(vote.partyId);
      const weight = party?.voteWeight ?? 1;
      totalWeight += weight;

      if (vote.decision === 'approve') {
        counts.approve++;
        approveWeight += weight * vote.confidence;
      } else if (vote.decision === 'reject') {
        counts.reject++;
        rejectWeight += weight * vote.confidence;
      } else if (vote.decision === 'conditional') {
        counts.conditional++;
        // Conditional counts as partial approve
        approveWeight += weight * vote.confidence * 0.5;
      } else {
        counts.abstain++;
      }
    }

    // Check if we have enough votes
    const totalVoters = this.parties.size;
    const votedCount = resolvedVotes.length;

    if (votedCount < totalVoters) {
      // Not all parties have voted
      return {
        reached: false,
        decision: null,
        votes: resolvedVotes,
        requiresHumanOverride: true,
        rulesApplied: this.getApplicableRules(),
        confidence: 0,
      };
    }

    // Determine consensus
    let reached = false;
    let decision: VoteDecision | null = null;
    let confidence = 0;

    if (required === 'unanimous') {
      if (counts.approve === totalVoters) {
        reached = true;
        decision = 'approve';
        confidence = approveWeight / totalWeight;
      } else if (counts.reject >= 1) {
        reached = true;
        decision = 'reject';
        confidence = rejectWeight / totalWeight;
      }
    } else if (required === 'supermajority') {
      const threshold = 0.66;
      if (counts.approve / totalVoters >= threshold) {
        reached = true;
        decision = 'approve';
        confidence = approveWeight / totalWeight;
      } else if (counts.reject / totalVoters >= threshold) {
        reached = true;
        decision = 'reject';
        confidence = rejectWeight / totalWeight;
      }
    } else if (required === 'majority') {
      if (counts.approve > totalVoters / 2) {
        reached = true;
        decision = 'approve';
        confidence = approveWeight / totalWeight;
      } else if (counts.reject > totalVoters / 2) {
        reached = true;
        decision = 'reject';
        confidence = rejectWeight / totalWeight;
      }
    } else if (typeof required === 'number') {
      if (counts.approve >= required) {
        reached = true;
        decision = 'approve';
        confidence = approveWeight / totalWeight;
      } else if (counts.reject >= required) {
        reached = true;
        decision = 'reject';
        confidence = rejectWeight / totalWeight;
      }
    }

    const dissent = resolvedVotes
      .filter(v => v.decision !== decision)
      .map(v => v.reasoning);

    const consensus: Consensus = {
      reached,
      decision,
      votes: resolvedVotes,
      dissent: dissent.length > 0 ? dissent : undefined,
      requiresHumanOverride: !reached || dissent.length > 0,
      rulesApplied: this.getApplicableRules(),
      confidence,
    };

    this.status = reached ? 'consensus' : 'deadlock';
    this.endedAt = new Date().toISOString();

    if (reached) {
      this.emit({ type: 'consensus_reached', consensus });
    } else {
      this.emit({ type: 'deadlock', votes: resolvedVotes });
    }

    return consensus;
  }

  /**
   * Human override of the protocol decision.
   */
  humanOverride(decision: VoteDecision, overriderId: string): Consensus {
    this.emit({ type: 'human_override', decision, overriderId });
    this.status = 'consensus';
    this.endedAt = new Date().toISOString();

    return {
      reached: true,
      decision,
      votes: Array.from(this.votes.values()),
      requiresHumanOverride: false,
      rulesApplied: this.getApplicableRules(),
      confidence: 1,
    };
  }

  /**
   * Get the session state.
   */
  getSession(): CouncilSession {
    return {
      id: this.id,
      protocol: this.config,
      parties: Array.from(this.parties.values()),
      votes: Array.from(this.votes.values()),
      discussion: this.discussion,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }

  /**
   * Subscribe to protocol events.
   */
  on(listener: (event: ProtocolEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  /**
   * Check if the protocol has expired.
   */
  isExpired(): boolean {
    if (!this.config.deadline) return false;
    return new Date() > new Date(this.config.deadline);
  }

  /**
   * Validate action against 81 rules.
   */
  validateAgainstRules(): { valid: boolean; violations: number[]; warnings: number[] } {
    const context = this.config.context || 'review';
    const result = checkRuleViolations(context, {
      isTransparent: true,
      hasConsent: this.votes.size === this.parties.size,
      isReversible: true,
      isAttributed: true,
      withinBudget: true,
      respectsDignity: true,
      isFair: true,
      isSustainable: true,
      isSafe: true,
    });

    return {
      valid: result.violated.length === 0,
      violations: result.violated.map(r => r.id),
      warnings: result.warnings.map(r => r.id),
    };
  }

  private getRequiredVotes(): ProtocolConfig['requiredVotes'] {
    return this.config.requiredVotes || 'majority';
  }

  private resolveDeferredVotes(votes: Vote[]): Vote[] {
    const resolved: Vote[] = [];
    const deferred = new Map<string, Vote>();

    for (const vote of votes) {
      if (vote.decision === 'defer' && vote.deferTo) {
        deferred.set(vote.partyId, vote);
      } else {
        resolved.push(vote);
      }
    }

    // Resolve deferred votes
    for (const [partyId, vote] of deferred) {
      const targetVote = votes.find(v => v.partyId === vote.deferTo);
      if (targetVote && targetVote.decision !== 'defer') {
        resolved.push({
          ...vote,
          decision: targetVote.decision,
          reasoning: `Deferred to ${vote.deferTo}: ${targetVote.reasoning}`,
        });
      } else {
        // If target also deferred or not found, abstain
        resolved.push({
          ...vote,
          decision: 'abstain',
          reasoning: `Deferred to ${vote.deferTo} but could not resolve`,
        });
      }
    }

    return resolved;
  }

  private getApplicableRules(): number[] {
    const context = this.config.context || 'review';
    const rules = getRulesByContext(context);
    
    if (this.config.rulesEnforced && this.config.rulesEnforced.length > 0) {
      return this.config.rulesEnforced;
    }

    // Return strict rules by default
    return rules.filter(r => r.enforcement === 'strict').map(r => r.id);
  }

  private emit(event: ProtocolEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[Protocol] Event listener error:', e);
      }
    }
  }
}

/**
 * Create a new protocol.
 */
export function createProtocol(config: ProtocolConfig): Protocol {
  return new Protocol(config);
}
