/**
 * M4 Phase-5 wage-settlement extension of canonical TickContext.
 *
 * WageSettlement is tick-scoped execution evidence. Authoritative wallets remain on
 * WorldState and move only through the explicit wage-settlement state transition.
 */
import type { WageSettlement } from "./wageSettlement";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly wageSettlements?: readonly WageSettlement[];
  }
}

export {};
