/**
 * M1 Milestone Preview generator (REQ-VISUALIZATION-004).
 *
 * Generates a deterministic JSON snapshot of the canonical M1 world-gen overview
 * showing scenario, State/Region/Currency/Clan counts and topology without
 * exposing mutable domain objects.
 */

import type { WorldState } from "../simulation/worldState";

export interface M1Preview {
  readonly milestone: "M1";
  readonly requirement: "REQ-VISUALIZATION-004";
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
  readonly states: Array<{
    readonly stateId: string;
    readonly name: string;
    readonly currencyId: string;
    readonly memberAuthorityId: string | null;
    readonly regionCount: number;
  }>;
  readonly currencies: Array<{
    readonly currencyId: string;
    readonly code: string;
    readonly issuerAuthorityId: string | null;
  }>;
  readonly regions: Array<{
    readonly regionId: string;
    readonly name: string;
    readonly controllerStateId: string | null;
    readonly settlementCurrencyId: string;
  }>;
  readonly clans: Array<{
    readonly clanId: string;
    readonly name: string;
  }>;
}

export function generateM1Preview(worldState: WorldState): M1Preview {
  // Build state-region mapping
  const regionsByState = new Map<string, Array<{ regionId: string; name: string; settlementCurrencyId: string }>>();
  const statesData: Array<{
    stateId: string;
    name: string;
    currencyId: string;
    memberAuthorityId: string | null;
    regionCount: number;
  }> = [];

  for (const [stateId, stateState] of worldState.states) {
    const stateIdStr = stateId as unknown as string;
    const currencyIdStr = stateState.effectiveCurrencyId as unknown as string;
    const memberAuthorityIdStr =
      stateState.memberAuthorityId !== null ? (stateState.memberAuthorityId as unknown as string) : null;

    regionsByState.set(stateIdStr, []);

    statesData.push({
      stateId: stateIdStr,
      name: stateState.seed.name,
      currencyId: currencyIdStr,
      memberAuthorityId: memberAuthorityIdStr,
      regionCount: 0, // Will fill in after counting regions
    });
  }

  // Build currency data
  const currenciesData: Array<{
    currencyId: string;
    code: string;
    issuerAuthorityId: string | null;
  }> = [];
  for (const [currencyId, currencyState] of worldState.currencies) {
    const currencyIdStr = currencyId as unknown as string;
    const issuerAuthorityIdStr =
      currencyState.issuerAuthorityId !== null ? (currencyState.issuerAuthorityId as unknown as string) : null;

    currenciesData.push({
      currencyId: currencyIdStr,
      code: currencyState.seed.code,
      issuerAuthorityId: issuerAuthorityIdStr,
    });
  }

  // Build regions data and update region counts
  const regionsData: Array<{
    regionId: string;
    name: string;
    controllerStateId: string | null;
    settlementCurrencyId: string;
  }> = [];
  for (const [regionId, regionState] of worldState.regions) {
    const regionIdStr = regionId as unknown as string;
    const controllerStateIdStr =
      regionState.controllerStateId !== null ? (regionState.controllerStateId as unknown as string) : null;
    const settlementCurrencyIdStr = regionState.settlementCurrencyId as unknown as string;

    regionsData.push({
      regionId: regionIdStr,
      name: regionState.seed.name,
      controllerStateId: controllerStateIdStr,
      settlementCurrencyId: settlementCurrencyIdStr,
    });

    if (controllerStateIdStr !== null && regionsByState.has(controllerStateIdStr)) {
      regionsByState.get(controllerStateIdStr)!.push({
        regionId: regionIdStr,
        name: regionState.seed.name,
        settlementCurrencyId: settlementCurrencyIdStr,
      });
    }
  }

  // Update region counts in states
  for (const stateData of statesData) {
    stateData.regionCount = regionsByState.get(stateData.stateId)?.length ?? 0;
  }

  // Build clans data
  const clansData: Array<{
    clanId: string;
    name: string;
  }> = [];
  for (const [clanId, clanState] of worldState.clans) {
    const clanIdStr = clanId as unknown as string;
    clansData.push({
      clanId: clanIdStr,
      name: clanState.seed.name,
    });
  }

  return {
    milestone: "M1",
    requirement: "REQ-VISUALIZATION-004",
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
    states: statesData,
    currencies: currenciesData,
    regions: regionsData,
    clans: clansData,
  };
}
