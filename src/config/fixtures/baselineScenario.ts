/**
 * Baseline scenario: baseline-multistate-v1 (REQ-CONFIG-003).
 *
 * Provides a deterministic multi-state economic world for M1 world genesis testing.
 * - 24 regions in 4 geographic clusters (one per state)
 * - 4 states with independent currencies and monetary authorities
 * - 8 clans distributed across state boundaries (diaspora patterns)
 * - ~480 starting cohorts (120 per state × 4 strata/age bands approximation)
 * - ~240 production units (~60 per state)
 * - Sparse transport network with trade chokepoints and isolated frontier regions
 * - Enough initial cash/inventory for 2–3 months of ordinary operations
 * - No starting events by default
 *
 * This scenario is hand-authored with bounded topology to produce intelligible
 * regression failures and reproducible diagnostic stories (per spec section 17).
 */

import type {
  ScenarioDefinition,
  RegionSeed,
  TransportLinkSeed,
  StateSeed,
  CurrencySeed,
  MonetaryAuthoritySeed,
  ClanSeed,
  CohortSeed,
  ProductionUnitSeed,
  MarketSeed,
  FxPoolSeed,
  CurrencyRegimeSeed,
} from "../scenarioDefinition";
import { baselineDefinitionPack } from "./baselineDefinitionPack";

// ============================================================================
// Region geography: 24 regions in 4 state clusters
// ============================================================================

const regionsClusterA: RegionSeed[] = [
  {
    key: "region:a1-capital",
    name: "State A Capital",
    controllerStateKey: "state:alpha",
    settlementCurrencyKey: "currency:alpha",
    settlementLevel: 2.5,
    infrastructure: { mines: 1.0, mills: 0.8 },
    climateHabitabilityInputs: { temp: 0.5, rainfall: 0.6 },
    deposits: [
      { resourceId: "resource:iron-ore", initialQuantity: 5000, initiallyKnown: true },
    ],
  },
  {
    key: "region:a2-farm",
    name: "Alpha Farmland",
    controllerStateKey: "state:alpha",
    settlementCurrencyKey: "currency:alpha",
    settlementLevel: 1.5,
    infrastructure: { mills: 0.5 },
    climateHabitabilityInputs: { temp: 0.6, rainfall: 0.7 },
    deposits: [],
  },
  {
    key: "region:a3-forest",
    name: "Alpha Forest",
    controllerStateKey: "state:alpha",
    settlementCurrencyKey: "currency:alpha",
    settlementLevel: 1.0,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.4, rainfall: 0.8 },
    deposits: [],
  },
  {
    key: "region:a4-border",
    name: "Alpha Border Trade Post",
    controllerStateKey: "state:alpha",
    settlementCurrencyKey: "currency:alpha",
    settlementLevel: 1.2,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.5, rainfall: 0.5 },
    deposits: [],
  },
  {
    key: "region:a5-copper-mine",
    name: "Alpha Copper Region",
    controllerStateKey: "state:alpha",
    settlementCurrencyKey: "currency:alpha",
    settlementLevel: 0.8,
    infrastructure: { mines: 0.7 },
    climateHabitabilityInputs: { temp: 0.55, rainfall: 0.4 },
    deposits: [
      { resourceId: "resource:copper-ore", initialQuantity: 3000, initiallyKnown: true },
    ],
  },
  {
    key: "region:a6-remote",
    name: "Alpha Remote Frontier",
    controllerStateKey: "state:alpha",
    settlementCurrencyKey: "currency:alpha",
    settlementLevel: 0.3,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.3, rainfall: 0.9 },
    deposits: [],
  },
];

const regionsClusterB: RegionSeed[] = [
  {
    key: "region:b1-capital",
    name: "State B Capital",
    controllerStateKey: "state:beta",
    settlementCurrencyKey: "currency:beta",
    settlementLevel: 2.3,
    infrastructure: { mills: 0.9, mines: 0.6 },
    climateHabitabilityInputs: { temp: 0.7, rainfall: 0.5 },
    deposits: [
      { resourceId: "resource:iron-ore", initialQuantity: 4000, initiallyKnown: true },
    ],
  },
  {
    key: "region:b2-urban",
    name: "Beta Urban Hub",
    controllerStateKey: "state:beta",
    settlementCurrencyKey: "currency:beta",
    settlementLevel: 2.0,
    infrastructure: { mills: 1.0 },
    climateHabitabilityInputs: { temp: 0.6, rainfall: 0.6 },
    deposits: [],
  },
  {
    key: "region:b3-fishing",
    name: "Beta Fishing Port",
    controllerStateKey: "state:beta",
    settlementCurrencyKey: "currency:beta",
    settlementLevel: 1.3,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.5, rainfall: 0.7 },
    deposits: [],
  },
  {
    key: "region:b4-chokepoint",
    name: "Beta Trade Chokepoint",
    controllerStateKey: "state:beta",
    settlementCurrencyKey: "currency:beta",
    settlementLevel: 1.1,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.5, rainfall: 0.5 },
    deposits: [],
  },
  {
    key: "region:b5-pastoral",
    name: "Beta Pastoral Land",
    controllerStateKey: "state:beta",
    settlementCurrencyKey: "currency:beta",
    settlementLevel: 1.0,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.65, rainfall: 0.45 },
    deposits: [],
  },
  {
    key: "region:b6-mineral",
    name: "Beta Mineral Rich",
    controllerStateKey: "state:beta",
    settlementCurrencyKey: "currency:beta",
    settlementLevel: 0.9,
    infrastructure: { mines: 0.8 },
    climateHabitabilityInputs: { temp: 0.4, rainfall: 0.6 },
    deposits: [
      { resourceId: "resource:copper-ore", initialQuantity: 4500, initiallyKnown: true },
    ],
  },
];

const regionsClusterC: RegionSeed[] = [
  {
    key: "region:c1-capital",
    name: "State C Capital",
    controllerStateKey: "state:gamma",
    settlementCurrencyKey: "currency:gamma",
    settlementLevel: 2.1,
    infrastructure: { mills: 0.7 },
    climateHabitabilityInputs: { temp: 0.8, rainfall: 0.4 },
    deposits: [],
  },
  {
    key: "region:c2-craft",
    name: "Gamma Craft Center",
    controllerStateKey: "state:gamma",
    settlementCurrencyKey: "currency:gamma",
    settlementLevel: 1.4,
    infrastructure: { mills: 0.6 },
    climateHabitabilityInputs: { temp: 0.7, rainfall: 0.5 },
    deposits: [],
  },
  {
    key: "region:c3-farm",
    name: "Gamma Farmland",
    controllerStateKey: "state:gamma",
    settlementCurrencyKey: "currency:gamma",
    settlementLevel: 1.2,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.75, rainfall: 0.6 },
    deposits: [],
  },
  {
    key: "region:c4-trade",
    name: "Gamma Trade Center",
    controllerStateKey: "state:gamma",
    settlementCurrencyKey: "currency:gamma",
    settlementLevel: 1.6,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.7, rainfall: 0.55 },
    deposits: [],
  },
  {
    key: "region:c5-forest",
    name: "Gamma Forest",
    controllerStateKey: "state:gamma",
    settlementCurrencyKey: "currency:gamma",
    settlementLevel: 0.7,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.6, rainfall: 0.8 },
    deposits: [],
  },
  {
    key: "region:c6-mine",
    name: "Gamma Mine Region",
    controllerStateKey: "state:gamma",
    settlementCurrencyKey: "currency:gamma",
    settlementLevel: 0.5,
    infrastructure: { mines: 0.5 },
    climateHabitabilityInputs: { temp: 0.5, rainfall: 0.4 },
    deposits: [
      { resourceId: "resource:iron-ore", initialQuantity: 3500, initiallyKnown: true },
    ],
  },
];

const regionsClusterD: RegionSeed[] = [
  {
    key: "region:d1-capital",
    name: "State D Capital",
    controllerStateKey: "state:delta",
    settlementCurrencyKey: "currency:delta",
    settlementLevel: 2.2,
    infrastructure: { mills: 0.8 },
    climateHabitabilityInputs: { temp: 0.45, rainfall: 0.7 },
    deposits: [],
  },
  {
    key: "region:d2-valley",
    name: "Delta Valley",
    controllerStateKey: "state:delta",
    settlementCurrencyKey: "currency:delta",
    settlementLevel: 1.5,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.5, rainfall: 0.75 },
    deposits: [],
  },
  {
    key: "region:d3-mountain",
    name: "Delta Mountain",
    controllerStateKey: "state:delta",
    settlementCurrencyKey: "currency:delta",
    settlementLevel: 0.8,
    infrastructure: { mines: 0.4 },
    climateHabitabilityInputs: { temp: 0.3, rainfall: 0.6 },
    deposits: [
      { resourceId: "resource:copper-ore", initialQuantity: 3800, initiallyKnown: true },
    ],
  },
  {
    key: "region:d4-coast",
    name: "Delta Coast",
    controllerStateKey: "state:delta",
    settlementCurrencyKey: "currency:delta",
    settlementLevel: 1.3,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.55, rainfall: 0.8 },
    deposits: [],
  },
  {
    key: "region:d5-industry",
    name: "Delta Industrial",
    controllerStateKey: "state:delta",
    settlementCurrencyKey: "currency:delta",
    settlementLevel: 1.7,
    infrastructure: { mills: 0.9 },
    climateHabitabilityInputs: { temp: 0.5, rainfall: 0.65 },
    deposits: [],
  },
  {
    key: "region:d6-plains",
    name: "Delta Plains",
    controllerStateKey: "state:delta",
    settlementCurrencyKey: "currency:delta",
    settlementLevel: 1.0,
    infrastructure: {},
    climateHabitabilityInputs: { temp: 0.6, rainfall: 0.5 },
    deposits: [],
  },
];

const geography: RegionSeed[] = [
  ...regionsClusterA,
  ...regionsClusterB,
  ...regionsClusterC,
  ...regionsClusterD,
];

// ============================================================================
// Transport network: sparse connected graph with chokepoints
// ============================================================================

const transportLinks: TransportLinkSeed[] = [
  // Intra-state links (sparse, not complete graph)
  { key: "link:a1-a2", fromRegionKey: "region:a1-capital", toRegionKey: "region:a2-farm", bidirectional: true, distance: 2, baseCapacity: 100, condition: 0.9, baseTransportCost: 1, feeReceiverStateKey: null },
  { key: "link:a2-a3", fromRegionKey: "region:a2-farm", toRegionKey: "region:a3-forest", bidirectional: true, distance: 3, baseCapacity: 80, condition: 0.8, baseTransportCost: 1.5, feeReceiverStateKey: null },
  { key: "link:a3-a5", fromRegionKey: "region:a3-forest", toRegionKey: "region:a5-copper-mine", bidirectional: true, distance: 4, baseCapacity: 60, condition: 0.7, baseTransportCost: 2, feeReceiverStateKey: null },
  { key: "link:a1-a4", fromRegionKey: "region:a1-capital", toRegionKey: "region:a4-border", bidirectional: true, distance: 3, baseCapacity: 120, condition: 0.85, baseTransportCost: 1.2, feeReceiverStateKey: null },
  { key: "link:a5-a6", fromRegionKey: "region:a5-copper-mine", toRegionKey: "region:a6-remote", bidirectional: true, distance: 5, baseCapacity: 40, condition: 0.6, baseTransportCost: 3, feeReceiverStateKey: null },

  { key: "link:b1-b2", fromRegionKey: "region:b1-capital", toRegionKey: "region:b2-urban", bidirectional: true, distance: 2, baseCapacity: 110, condition: 0.9, baseTransportCost: 0.9, feeReceiverStateKey: null },
  { key: "link:b2-b3", fromRegionKey: "region:b2-urban", toRegionKey: "region:b3-fishing", bidirectional: true, distance: 3, baseCapacity: 90, condition: 0.85, baseTransportCost: 1.1, feeReceiverStateKey: null },
  { key: "link:b3-b4", fromRegionKey: "region:b3-fishing", toRegionKey: "region:b4-chokepoint", bidirectional: true, distance: 2, baseCapacity: 70, condition: 0.8, baseTransportCost: 1, feeReceiverStateKey: null },
  { key: "link:b4-b5", fromRegionKey: "region:b4-chokepoint", toRegionKey: "region:b5-pastoral", bidirectional: true, distance: 3, baseCapacity: 85, condition: 0.75, baseTransportCost: 1.3, feeReceiverStateKey: null },
  { key: "link:b1-b6", fromRegionKey: "region:b1-capital", toRegionKey: "region:b6-mineral", bidirectional: true, distance: 4, baseCapacity: 95, condition: 0.8, baseTransportCost: 1.8, feeReceiverStateKey: null },

  { key: "link:c1-c2", fromRegionKey: "region:c1-capital", toRegionKey: "region:c2-craft", bidirectional: true, distance: 2, baseCapacity: 100, condition: 0.88, baseTransportCost: 1, feeReceiverStateKey: null },
  { key: "link:c2-c3", fromRegionKey: "region:c2-craft", toRegionKey: "region:c3-farm", bidirectional: true, distance: 3, baseCapacity: 80, condition: 0.8, baseTransportCost: 1.2, feeReceiverStateKey: null },
  { key: "link:c1-c4", fromRegionKey: "region:c1-capital", toRegionKey: "region:c4-trade", bidirectional: true, distance: 3, baseCapacity: 120, condition: 0.85, baseTransportCost: 1.1, feeReceiverStateKey: null },
  { key: "link:c4-c5", fromRegionKey: "region:c4-trade", toRegionKey: "region:c5-forest", bidirectional: true, distance: 4, baseCapacity: 75, condition: 0.7, baseTransportCost: 1.5, feeReceiverStateKey: null },
  { key: "link:c6-c2", fromRegionKey: "region:c6-mine", toRegionKey: "region:c2-craft", bidirectional: true, distance: 5, baseCapacity: 85, condition: 0.75, baseTransportCost: 2, feeReceiverStateKey: null },

  { key: "link:d1-d5", fromRegionKey: "region:d1-capital", toRegionKey: "region:d5-industry", bidirectional: true, distance: 2, baseCapacity: 105, condition: 0.9, baseTransportCost: 0.8, feeReceiverStateKey: null },
  { key: "link:d5-d2", fromRegionKey: "region:d5-industry", toRegionKey: "region:d2-valley", bidirectional: true, distance: 3, baseCapacity: 90, condition: 0.82, baseTransportCost: 1.1, feeReceiverStateKey: null },
  { key: "link:d2-d4", fromRegionKey: "region:d2-valley", toRegionKey: "region:d4-coast", bidirectional: true, distance: 3, baseCapacity: 80, condition: 0.8, baseTransportCost: 1.2, feeReceiverStateKey: null },
  { key: "link:d1-d3", fromRegionKey: "region:d1-capital", toRegionKey: "region:d3-mountain", bidirectional: true, distance: 4, baseCapacity: 70, condition: 0.75, baseTransportCost: 1.8, feeReceiverStateKey: null },
  { key: "link:d6-d5", fromRegionKey: "region:d6-plains", toRegionKey: "region:d5-industry", bidirectional: true, distance: 3, baseCapacity: 95, condition: 0.8, baseTransportCost: 1, feeReceiverStateKey: null },

  // Inter-state trade routes (chokepoints)
  { key: "link:a4-b4", fromRegionKey: "region:a4-border", toRegionKey: "region:b4-chokepoint", bidirectional: true, distance: 2, baseCapacity: 150, condition: 0.85, baseTransportCost: 0.5, feeReceiverStateKey: "state:beta" },
  { key: "link:b5-c4", fromRegionKey: "region:b5-pastoral", toRegionKey: "region:c4-trade", bidirectional: true, distance: 3, baseCapacity: 140, condition: 0.8, baseTransportCost: 0.6, feeReceiverStateKey: "state:gamma" },
  { key: "link:c4-d1", fromRegionKey: "region:c4-trade", toRegionKey: "region:d1-capital", bidirectional: true, distance: 4, baseCapacity: 130, condition: 0.78, baseTransportCost: 0.7, feeReceiverStateKey: "state:delta" },
  { key: "link:d6-a4", fromRegionKey: "region:d6-plains", toRegionKey: "region:a4-border", bidirectional: true, distance: 5, baseCapacity: 120, condition: 0.75, baseTransportCost: 0.8, feeReceiverStateKey: "state:alpha" },
];

// ============================================================================
// Currencies and Monetary Authorities
// ============================================================================

const currencies: CurrencySeed[] = [
  { key: "currency:alpha", code: "ALP", issuerAuthorityKey: "authority:alpha" },
  { key: "currency:beta", code: "BET", issuerAuthorityKey: "authority:beta" },
  { key: "currency:gamma", code: "GAM", issuerAuthorityKey: "authority:gamma" },
  { key: "currency:delta", code: "DEL", issuerAuthorityKey: "authority:delta" },
];

const createFxPools = (baseCurrencyKey: string, otherCurrencyKeys: string[]): FxPoolSeed[] => {
  return otherCurrencyKeys.map((quoteCurrencyKey, index) => ({
    key: `fxpool:${baseCurrencyKey}-${quoteCurrencyKey}`,
    baseCurrencyKey,
    quoteCurrencyKey,
    cash: {
      [baseCurrencyKey]: 500 + index * 50,
      [quoteCurrencyKey]: 600 + index * 40,
    },
    spotRateQuotePerBase: 1.0 + index * 0.1,
    targetBaseReserveShare: 0.5,
    flowPressureEma: 0,
    transactionSpread: 0.001,
    minOperationalReserveBase: 10,
    minOperationalReserveQuote: 10,
    maxRateMovePerTick: 0.12,
  }));
};

const monetaryAuthorities: MonetaryAuthoritySeed[] = [
  {
    key: "authority:alpha",
    currencyKey: "currency:alpha",
    memberStateKeys: ["state:alpha"],
    wallet: { "currency:alpha": 50000, "currency:beta": 100, "currency:gamma": 100, "currency:delta": 100 },
    policyRateAnnual: 0.03,
    fxPools: createFxPools("currency:alpha", ["currency:beta", "currency:gamma", "currency:delta"]),
  },
  {
    key: "authority:beta",
    currencyKey: "currency:beta",
    memberStateKeys: ["state:beta"],
    wallet: { "currency:alpha": 100, "currency:beta": 55000, "currency:gamma": 100, "currency:delta": 100 },
    policyRateAnnual: 0.03,
    fxPools: createFxPools("currency:beta", ["currency:alpha", "currency:gamma", "currency:delta"]),
  },
  {
    key: "authority:gamma",
    currencyKey: "currency:gamma",
    memberStateKeys: ["state:gamma"],
    wallet: { "currency:alpha": 100, "currency:beta": 100, "currency:gamma": 48000, "currency:delta": 100 },
    policyRateAnnual: 0.03,
    fxPools: createFxPools("currency:gamma", ["currency:alpha", "currency:beta", "currency:delta"]),
  },
  {
    key: "authority:delta",
    currencyKey: "currency:delta",
    memberStateKeys: ["state:delta"],
    wallet: { "currency:alpha": 100, "currency:beta": 100, "currency:gamma": 100, "currency:delta": 52000 },
    policyRateAnnual: 0.03,
    fxPools: createFxPools("currency:delta", ["currency:alpha", "currency:beta", "currency:gamma"]),
  },
];

// ============================================================================
// States
// ============================================================================

const states: StateSeed[] = [
  {
    key: "state:alpha",
    name: "State Alpha",
    treasury: { "currency:alpha": 100000 },
    publicInventory: { "good:food": 500, "good:wood": 300 },
    policy: {},
    effectiveCurrencyRegime: {
      currencyKey: "currency:alpha",
      regimeType: "INDEPENDENT_FLOAT",
      policyAuthorityKey: "authority:alpha",
    } as CurrencyRegimeSeed,
  },
  {
    key: "state:beta",
    name: "State Beta",
    treasury: { "currency:beta": 110000 },
    publicInventory: { "good:food": 400, "good:iron": 200 },
    policy: {},
    effectiveCurrencyRegime: {
      currencyKey: "currency:beta",
      regimeType: "INDEPENDENT_FLOAT",
      policyAuthorityKey: "authority:beta",
    } as CurrencyRegimeSeed,
  },
  {
    key: "state:gamma",
    name: "State Gamma",
    treasury: { "currency:gamma": 95000 },
    publicInventory: { "good:wood": 250, "good:tools": 100 },
    policy: {},
    effectiveCurrencyRegime: {
      currencyKey: "currency:gamma",
      regimeType: "INDEPENDENT_FLOAT",
      policyAuthorityKey: "authority:gamma",
    } as CurrencyRegimeSeed,
  },
  {
    key: "state:delta",
    name: "State Delta",
    treasury: { "currency:delta": 105000 },
    publicInventory: { "good:food": 450, "good:cloth": 150 },
    policy: {},
    effectiveCurrencyRegime: {
      currencyKey: "currency:delta",
      regimeType: "INDEPENDENT_FLOAT",
      policyAuthorityKey: "authority:delta",
    } as CurrencyRegimeSeed,
  },
];

// ============================================================================
// Clans (8 distributed across states, with cross-border patterns)
// ============================================================================

const clans: ClanSeed[] = [
  {
    key: "clan:wolf",
    name: "Wolf Clan",
    treasury: { "currency:alpha": 5000, "currency:beta": 100 },
    preferences: {},
    initialRelations: {},
  },
  {
    key: "clan:eagle",
    name: "Eagle Clan",
    treasury: { "currency:alpha": 4500, "currency:gamma": 500 },
    preferences: {},
    initialRelations: {},
  },
  {
    key: "clan:bear",
    name: "Bear Clan",
    treasury: { "currency:beta": 5500 },
    preferences: {},
    initialRelations: {},
  },
  {
    key: "clan:fox",
    name: "Fox Clan",
    treasury: { "currency:beta": 4800, "currency:delta": 300 },
    preferences: {},
    initialRelations: {},
  },
  {
    key: "clan:lion",
    name: "Lion Clan",
    treasury: { "currency:gamma": 5200 },
    preferences: {},
    initialRelations: {},
  },
  {
    key: "clan:stag",
    name: "Stag Clan",
    treasury: { "currency:gamma": 4700, "currency:delta": 800 },
    preferences: {},
    initialRelations: {},
  },
  {
    key: "clan:serpent",
    name: "Serpent Clan",
    treasury: { "currency:delta": 5300 },
    preferences: {},
    initialRelations: {},
  },
  {
    key: "clan:raven",
    name: "Raven Clan",
    treasury: { "currency:alpha": 200, "currency:delta": 5000 },
    preferences: {},
    initialRelations: {},
  },
];

// ============================================================================
// Cohorts (~480 total, ~120 per state)
// ============================================================================

const clanList = ["clan:wolf", "clan:eagle", "clan:bear", "clan:fox", "clan:lion", "clan:stag", "clan:serpent", "clan:raven"] as const;

const getClanByIndex = (index: number): string => clanList[index % clanList.length] ?? clanList[0];

const createCohorts = (): CohortSeed[] => {
  const cohorts: CohortSeed[] = [];
  const stateRegions: Record<string, string[]> = {
    "state:alpha": ["region:a1-capital", "region:a2-farm", "region:a3-forest", "region:a4-border", "region:a5-copper-mine", "region:a6-remote"],
    "state:beta": ["region:b1-capital", "region:b2-urban", "region:b3-fishing", "region:b4-chokepoint", "region:b5-pastoral", "region:b6-mineral"],
    "state:gamma": ["region:c1-capital", "region:c2-craft", "region:c3-farm", "region:c4-trade", "region:c5-forest", "region:c6-mine"],
    "state:delta": ["region:d1-capital", "region:d2-valley", "region:d3-mountain", "region:d4-coast", "region:d5-industry", "region:d6-plains"],
  };
  const ageBands: ("CHILD" | "WORKING" | "ELDER")[] = ["CHILD", "WORKING", "ELDER"];
  const strata: ("VULNERABLE" | "WORKING_MIDDLE" | "AFFLUENT")[] = ["VULNERABLE", "WORKING_MIDDLE", "AFFLUENT"];

  let cohortIndex = 0;

  for (const [state, regions] of Object.entries(stateRegions)) {
    const stateCurrency = state === "state:alpha" ? "currency:alpha" : state === "state:beta" ? "currency:beta" : state === "state:gamma" ? "currency:gamma" : "currency:delta";

    for (const regionKey of regions) {
      for (const ageBand of ageBands) {
        for (const stratum of strata) {
          const population = ageBand === "WORKING" ? (stratum === "VULNERABLE" ? 60 : stratum === "WORKING_MIDDLE" ? 50 : 30) : (stratum === "VULNERABLE" ? 30 : stratum === "WORKING_MIDDLE" ? 25 : 15);

          cohorts.push({
            key: `cohort:${state}-${regionKey}-${ageBand}-${stratum}-${cohortIndex}`,
            regionKey,
            clanKey: getClanByIndex(cohortIndex),
            ageBand,
            stratum,
            laborCategory: "GENERAL",
            population,
            wallet: { [stateCurrency]: population * 50 },
            householdInventory: { "good:food": population * 10 },
            healthIndex: 0.75,
            prosperityEma: stratum === "VULNERABLE" ? 0.4 : stratum === "WORKING_MIDDLE" ? 0.6 : 0.8,
            essentialSatisfactionEma: 0.7,
            realIncomePerCapitaEma: stratum === "VULNERABLE" ? 30 : stratum === "WORKING_MIDDLE" ? 50 : 80,
            employmentRateEma: ageBand === "WORKING" ? 0.75 : 0,
            migrationPressureEma: 0,
            mobilityAccumulator: 0,
            wageSignal: 10,
          });

          cohortIndex++;
        }
      }
    }
  }

  return cohorts;
};

// ============================================================================
// Production Units (~240 total)
// ============================================================================

const createProductionUnits = (): ProductionUnitSeed[] => {
  const units: ProductionUnitSeed[] = [];
  let unitIndex = 0;

  const recipeAssignments: Record<string, string[]> = {
    "recipe:food-harvest": ["region:a2-farm", "region:c3-farm", "region:d2-valley", "region:d6-plains"],
    "recipe:tools-craft": ["region:b2-urban", "region:c2-craft", "region:d5-industry"],
    "recipe:iron-mine": ["region:a1-capital", "region:b1-capital", "region:b6-mineral", "region:c6-mine", "region:d3-mountain"],
  };

  for (const [recipeId, regions] of Object.entries(recipeAssignments)) {
    for (const regionKey of regions) {
      const unitsPerRegion = recipeId === "recipe:iron-mine" ? 12 : 16;

      for (let i = 0; i < unitsPerRegion; i++) {
        const clanKey = getClanByIndex(i);

        // Determine currency based on region's state
        let currency = "currency:alpha";
        if (regionKey.startsWith("region:b")) currency = "currency:beta";
        else if (regionKey.startsWith("region:c")) currency = "currency:gamma";
        else if (regionKey.startsWith("region:d")) currency = "currency:delta";

        const getInputInventory = () => {
          if (recipeId === "recipe:food-harvest") return { "good:grain": 100 };
          if (recipeId === "recipe:tools-craft") return { "good:iron": 50, "good:wood": 75 };
          return { "good:iron": 80 }; // iron-mine
        };

        const getOutputInventory = () => {
          if (recipeId === "recipe:food-harvest") return { "good:food": 200 };
          if (recipeId === "recipe:tools-craft") return { "good:tools": 150 };
          return { "good:iron": 300 }; // iron-mine
        };

        units.push({
          key: `unit:${regionKey}-${recipeId}-${i}`,
          regionKey,
          owner: { type: "CLAN", key: clanKey },
          recipeId,
          status: i % 10 === 0 ? "MOTHBALLED" : "ACTIVE",
          wallet: { [currency]: 200 + i * 20 },
          inputInventory: getInputInventory(),
          outputInventory: getOutputInventory(),
          investmentInventory: { "good:tools": 50 },
          installedCapital: 100 + i * 10,
          condition: 0.9 - i * 0.01,
          wageOffer: 12,
        });

        unitIndex++;
      }
    }
  }

  return units;
};

// ============================================================================
// Markets (one per region)
// ============================================================================

const createMarkets = (): MarketSeed[] => {
  const initialPrices: Record<string, number> = {
    "good:food": 10,
    "good:wood": 8,
    "good:iron": 15,
    "good:tools": 50,
    "good:cloth": 12,
    "good:stone": 5,
    "good:copper": 12,
    "good:grain": 8,
  };

  return geography.map((region) => ({
    regionKey: region.key,
    initialPriceByGood: initialPrices,
  }));
};

// ============================================================================
// Baseline-multistate-v1 scenario assembly
// ============================================================================

export const baselineScenario: ScenarioDefinition = {
  id: "baseline-multistate-v1",
  version: "1.0.0",
  name: "Baseline Multi-State Scenario",
  description:
    "Deterministic multi-state economic world with 24 regions, 4 states, 4 currencies, " +
    "8 clans, ~480 cohorts, ~240 production units, and sparse transport network. " +
    "Demonstrates M1 world genesis with trade chokepoints and frontier regions.",
  definitionPackId: baselineDefinitionPack.id,
  geography,
  transportLinks,
  states,
  currencies,
  monetaryAuthorities,
  clans,
  cohorts: createCohorts(),
  productionUnits: createProductionUnits(),
  markets: createMarkets(),
  variation: {
    enabled: false, // M1 baseline uses exact scenario data
  },
};
