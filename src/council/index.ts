/**
 * @fileoverview
 * Codmir Council - Protocol Agreement System
 * 
 * The Council is where AI systems and humans form agreements.
 * Every contract is a constant creation of agreement between parties.
 * 
 * Built on:
 * - Grace Foundation principles
 * - 5 Seeds of governance
 * - 81 Rules (9x9 matrix from seeds)
 * - Protocol-based voting
 * 
 * @example
 * ```typescript
 * import { Council, Protocol } from '@codmir/sdk/council';
 * 
 * const council = new Council();
 * 
 * // Create a protocol (agreement)
 * const protocol = council.createProtocol({
 *   topic: 'Deploy to production',
 *   parties: ['ai:overseer', 'ai:reviewer', 'human:admin'],
 *   requiredVotes: 'majority',
 * });
 * 
 * // Each party votes
 * await protocol.vote('ai:overseer', { decision: 'approve', reasoning: '...' });
 * await protocol.vote('ai:reviewer', { decision: 'approve', reasoning: '...' });
 * await protocol.vote('human:admin', { decision: 'approve', reasoning: '...' });
 * 
 * // Check consensus
 * const result = await protocol.resolve();
 * ```
 */

export { Council, createCouncil } from './council';
export { Protocol, createProtocol } from './protocol';
export { Representative, createRepresentative } from './representative';
export { Rules, THE_81_RULES, SEEDS } from './rules';
export { GraceIntegration } from './grace-integration';

// Value creation and Grace economy
export {
  GraceEconomy,
  getGraceEconomy,
  calculateGraceValue,
  assessBetterGood,
  createValueIntent,
  formatNewAgreement,
  THE_NEW_AGREEMENT,
} from './value';

export type {
  CouncilConfig,
  ProtocolConfig,
  Vote,
  VoteDecision,
  Consensus,
  Party,
  PartyType,
  RepresentativeConfig,
  Rule,
  Seed,
  SeedCategory,
} from './types';

// Re-export the council session types
export type {
  CouncilSession,
  DiscussionMessage,
} from './types';

// Value types
export type {
  ValueCategory,
  ValueCreationIntent,
  ValueBeneficiary,
  ValueMetric,
  BetterGoodAssessment,
  Contribution,
  GraceToken,
  GraceAgreement,
} from './value';

// Founder's Rule Book
export {
  THE_OLD_SYSTEM,
  THE_NEW_SYSTEM,
  AI_GOVERNANCE_TERMS,
  CONTRACT_SEEDS,
  FOUNDERS_MESSAGE,
  formatFoundersRulebook,
  validateContract,
} from './founders-rulebook';

export type {
  GraceContract,
  ContractParty,
  StateLogEntry,
  EthicsAssessment,
  ExitRight,
  SeedValidation,
} from './founders-rulebook';
