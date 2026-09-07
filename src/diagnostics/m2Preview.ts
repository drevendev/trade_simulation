/**
 * M2 Milestone Preview generator (REQ-VISUALIZATION-005).
 *
 * Generates a deterministic JSON snapshot of the canonical M2 tick orchestration
 * and zero-flow reconciliation health showing phase trace (0–15), tick counter
 * and per-category reconciliation results without exposing mutable domain objects.
 */

import type { WorldState } from "../simulation/worldState";
import { executeTick, noOpPhaseHandler, TOTAL_PHASES } from "../simulation/tickOrchestrator";
import { projectM2DiagnosticTick, aggregateM2DiagnosticRun, type M2DiagnosticRunProjection } from "../simulation/m2DiagnosticProjection";

export interface M2Preview {
  readonly milestone: "M2";
  readonly requirement: "REQ-VISUALIZATION-005";
  readonly scenario: {
    readonly scenarioId: string;
    readonly seed: number;
    readonly configVersion: string;
  };
  readonly worldTopology: {
    readonly stateCount: number;
    readonly regionCount: number;
    readonly currencyCount: number;
    readonly monetaryAuthorityCount: number;
    readonly clanCount: number;
    readonly cohortCount: number;
    readonly productionUnitCount: number;
    readonly marketCount: number;
    readonly transportLinkCount: number;
  };
  readonly phaseTrace: {
    readonly phasesPerTick: number;
    readonly phaseSequence: ReadonlyArray<number>;
    readonly totalPhasesExecuted: number;
  };
  readonly tickExecution: {
    readonly ticksExecuted: number;
    readonly tickRange: {
      readonly firstTick: number;
      readonly lastTick: number;
    };
  };
  readonly reconciliationHealth: {
    readonly passedTicks: number;
    readonly failedTicks: number;
    readonly failureDetails: ReadonlyArray<{
      readonly tick: number;
      readonly errors: ReadonlyArray<{
        readonly category: string;
        readonly residual: number;
      }>;
    }>;
    readonly tolerance: number;
  };
}

export function generateM2Preview(worldState: WorldState, ticks: number = 100): M2Preview {
  const tickProjections = [];
  let currentWorld = worldState;
  const emptyPendingTransitions = {
    jurisdictionChanges: [],
    stateCreations: [],
    policyChanges: [],
    monetaryPolicyChanges: [],
  };

  // Execute no-op ticks to capture phase trace and reconciliation
  for (let tickNum = 1; tickNum <= ticks; tickNum++) {
    const result = executeTick(currentWorld, tickNum, emptyPendingTransitions, noOpPhaseHandler);
    const projection = projectM2DiagnosticTick(result.context.currentLedger, result.reconciliationErrors);
    tickProjections.push(projection);
  }

  // Aggregate results
  const aggregated = aggregateM2DiagnosticRun(tickProjections);

  // Build preview (ensure tick values are numbers)
  const aggregatedFirstTick = (aggregated.firstTick ?? 0) as number;
  const aggregatedLastTick = (aggregated.lastTick ?? 0) as number;

  return {
    milestone: "M2",
    requirement: "REQ-VISUALIZATION-005",
    scenario: {
      scenarioId: worldState.scenarioId,
      seed: worldState.seed,
      configVersion: worldState.configVersion,
    },
    worldTopology: {
      stateCount: worldState.states.size,
      regionCount: worldState.regions.size,
      currencyCount: worldState.currencies.size,
      monetaryAuthorityCount: worldState.monetaryAuthorities.size,
      clanCount: worldState.clans.size,
      cohortCount: worldState.cohorts.size,
      productionUnitCount: worldState.productionUnits.size,
      marketCount: worldState.markets.size,
      transportLinkCount: worldState.transportLinks.size,
    },
    phaseTrace: {
      phasesPerTick: TOTAL_PHASES,
      phaseSequence: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      totalPhasesExecuted: TOTAL_PHASES * ticks,
    },
    tickExecution: {
      ticksExecuted: ticks,
      tickRange: {
        firstTick: aggregatedFirstTick,
        lastTick: aggregatedLastTick,
      },
    },
    reconciliationHealth: {
      passedTicks: aggregated.reconciliationPassCount,
      failedTicks: aggregated.reconciliationFailCount,
      failureDetails: aggregated.failedTicks,
      tolerance: worldState.simulationConfig.numeric.reconciliationRelativeTolerance ?? 1e-9,
    },
  };
}
