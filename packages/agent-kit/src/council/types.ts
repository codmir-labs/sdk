/**
 * @fileoverview
 * Council Type Definitions
 * 
 * Types for the protocol agreement system between AI and humans.
 */

/**
 * Party types in the council.
 */
export type PartyType = 'ai' | 'human' | 'system' | 'community';

/**
 * A party in the council (can be AI agent, human, or system).
 */
export interface Party {
  id: string;
  type: PartyType;
  name: string;
  role?: string;
  capabilities?: string[];
  trustScore?: number;
  voteWeight?: number;
}

/**
 * Vote decision options.
 */
export type VoteDecision = 
  | 'approve'
  | 'reject'
  | 'abstain'
  | 'defer'       // Defer to another party
  | 'conditional' // Approve with conditions

/**
 * A vote cast by a party.
 */
export interface Vote {
  partyId: string;
  decision: VoteDecision;
  confidence: number;  // 0-1
  reasoning: string;
  conditions?: string[];  // If conditional
  deferTo?: string;       // If defer
  timestamp: string;
  rulesCited?: number[];  // Which of the 81 rules support this vote
}

/**
 * Consensus result.
 */
export interface Consensus {
  reached: boolean;
  decision: VoteDecision | null;
  votes: Vote[];
  dissent?: string[];
  requiresHumanOverride: boolean;
  rulesApplied: number[];
  confidence: number;
}

/**
 * Seed categories (the 5 original seeds).
 */
export type SeedCategory = 
  | 'contract'      // Seed 1: Contract Schema
  | 'state'         // Seed 2: Execution State Machine
  | 'separation'    // Seed 3: Engine/Runtime Separation
  | 'policy'        // Seed 4: Policy Enforcement
  | 'distribution'  // Seed 5: Distributed Workers

/**
 * A seed - foundational principle.
 */
export interface Seed {
  id: number;
  category: SeedCategory;
  name: string;
  principle: string;
  description: string;
}

/**
 * A rule derived from seeds (81 rules = 9 aspects × 9 contexts).
 */
export interface Rule {
  id: number;
  seeds: number[];        // Which seeds this rule derives from
  name: string;
  statement: string;
  enforcement: 'strict' | 'advisory' | 'aspirational';
  context: RuleContext;
  aspect: RuleAspect;
}

/**
 * Rule contexts (9 contexts).
 */
export type RuleContext =
  | 'execution'       // During task execution
  | 'planning'        // During planning/preparation
  | 'review'          // During review/approval
  | 'error'           // During error handling
  | 'scaling'         // During scaling operations
  | 'communication'   // During inter-party communication
  | 'storage'         // During data storage/retrieval
  | 'authentication'  // During auth/identity
  | 'termination'     // During shutdown/cleanup

/**
 * Rule aspects (9 aspects).
 */
export type RuleAspect =
  | 'transparency'    // Openness and visibility
  | 'consent'         // Permission and agreement
  | 'reversibility'   // Undo capability
  | 'accountability'  // Attribution and audit
  | 'economy'         // Resource and cost
  | 'dignity'         // Human respect
  | 'fairness'        // Equal treatment
  | 'sustainability'  // Long-term viability
  | 'safety'          // Protection from harm

/**
 * Council configuration.
 */
export interface CouncilConfig {
  name?: string;
  defaultConsensusThreshold?: number;  // 0-1, default 0.66
  maxDiscussionRounds?: number;
  timeoutMs?: number;
  enforceRules?: boolean;
  graceEnabled?: boolean;
}

/**
 * Protocol configuration.
 */
export interface ProtocolConfig {
  id?: string;
  topic: string;
  description?: string;
  parties: string[];  // Party IDs
  requiredVotes: 'unanimous' | 'majority' | 'supermajority' | number;
  deadline?: string;  // ISO timestamp
  context?: RuleContext;
  rulesEnforced?: number[];  // Specific rules to enforce
  allowConditional?: boolean;
  allowDefer?: boolean;
  maxRounds?: number;
}

/**
 * Representative configuration.
 */
export interface RepresentativeConfig {
  id: string;
  type: PartyType;
  name: string;
  role?: string;
  systemPrompt?: string;
  capabilities?: string[];
  voteWeight?: number;
  autoVote?: boolean;
  votingStrategy?: 'conservative' | 'progressive' | 'balanced';
}

/**
 * Council session.
 */
export interface CouncilSession {
  id: string;
  protocol: ProtocolConfig;
  parties: Party[];
  votes: Vote[];
  discussion: DiscussionMessage[];
  status: 'forming' | 'discussing' | 'voting' | 'consensus' | 'deadlock' | 'expired';
  startedAt: string;
  endedAt?: string;
  consensus?: Consensus;
}

/**
 * Discussion message in council.
 */
export interface DiscussionMessage {
  id: string;
  partyId: string;
  content: string;
  replyTo?: string;
  timestamp: string;
  round: number;
}

/**
 * Protocol event types.
 */
export type ProtocolEvent =
  | { type: 'created'; protocol: ProtocolConfig }
  | { type: 'party_joined'; partyId: string }
  | { type: 'discussion'; message: DiscussionMessage }
  | { type: 'vote_cast'; vote: Vote }
  | { type: 'vote_changed'; vote: Vote; previousDecision: VoteDecision }
  | { type: 'consensus_reached'; consensus: Consensus }
  | { type: 'deadlock'; votes: Vote[] }
  | { type: 'expired'; reason: string }
  | { type: 'human_override'; decision: VoteDecision; overriderId: string }
