import { describe, expect, it } from "vitest";

import type { RecipeDefinition } from "../config/definitionPack";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, ProductionUnitId } from "../domain/id";
import {
  applyCapitalFormationTransition,
  createPhase12CapitalFormationHandler,
  planCapitalFormationPhase12,
} from "./capitalFormation";
import { deriveNameplateCapacity } from "./productionUnitState";
import { initializeTickContext } from "./tickOrchestrator";
import type { ProductionUnitState, WorldState } from "./worldState";
import { buildInitialWorld } from "./worldState";

const TOOLS = "good:tools" as GoodId;
const IRON = "good:iron" as GoodId;

function capitalRecipe(overrides: Partial<RecipeDefinition> = {}): RecipeDefinition {
  const base = baselineDefinitionPack.recipes["recipe:tools-craft"]!;
  return {
    ...base,
    investmentGoodsPerCapitalUnit: {
      [TOOLS]: 2,
      [IRON]: 4,
    } as Readonly<Record<GoodId, number>>,
    batchesPerCapitalUnit: 2,
    depreciationRatePerTick: 0.25,
    ...overrides,
  };
}

function oneUnitWorld(args: {
  readonly recipe?: RecipeDefinition;
  readonly installedCapital?: number;
  readonly investment?: readonly (readonly [GoodId, number])[];
} = {}): { world: WorldState; unit: ProductionUnitState; recipe: RecipeDefinition } {
  const baseWorld = buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );
  const baseUnit = [...baseWorld.productionUnits.values()][0]!;
  const recipe = args.recipe ?? capitalRecipe();
  const unit: ProductionUnitState = {
    ...baseUnit,
    seed: {
      ...baseUnit.seed,
      recipeId: recipe.id,
    },
    installedCapital: args.installedCapital ?? 10,
    investmentInventory: new Map(args.investment ?? [[TOOLS, 6], [IRON, 8]]),
  };
  const world: WorldState = {
    ...baseWorld,
    definitionRegistry: {
      ...baseWorld.definitionRegistry,
      recipes: {
        ...baseWorld.definitionRegistry.recipes,
        [recipe.id]: recipe,
      },
    },
    productionUnits: new Map([[unit.productionUnitId, unit]]),
  };
  return { world, unit, recipe };
}

function normalizedExecutions(world: WorldState) {
  return planCapitalFormationPhase12({ world, tick: 7 }).executions.map((execution) => ({
    ...execution,
    openingInvestmentQuantityByGood: Object.entries(execution.openingInvestmentQuantityByGood),
    investmentGoodsConsumedByGood: Object.entries(execution.investmentGoodsConsumedByGood),
  }));
}

describe("REQ-PRODUCTION-006 Phase-12 capital formation", () => {
  it("consumes complete real-goods bundles exactly once, then depreciates post-formation capital", () => {
    const { world, unit, recipe } = oneUnitWorld();
    const openingWallet = unit.wallet;
    const openingInput = unit.inputInventory;
    const openingOutput = unit.outputInventory;

    const { executions } = planCapitalFormationPhase12({ world, tick: 7 });
    expect(executions).toHaveLength(1);
    const execution = executions[0]!;

    expect(execution.openingInstalledCapital).toBe(10);
    expect(execution.possibleCapitalFromGoods).toBe(2);
    expect(execution.capitalBuilt).toBe(2);
    expect(execution.investmentGoodsConsumedByGood).toEqual({
      [IRON]: 8,
      [TOOLS]: 4,
    });
    expect(execution.postFormationInstalledCapital).toBe(12);
    expect(execution.depreciationUnits).toBe(3);
    expect(execution.installedCapitalNext).toBe(9);
    expect(execution.nameplateCapacityNext).toBe(18);

    const nextWorld = applyCapitalFormationTransition(world, executions);
    const nextUnit = nextWorld.productionUnits.get(unit.productionUnitId)!;
    expect(nextUnit.investmentInventory.get(TOOLS)).toBe(2);
    expect(nextUnit.investmentInventory.get(IRON)).toBe(0);
    expect(nextUnit.installedCapital).toBe(9);
    expect(deriveNameplateCapacity(nextUnit, recipe)).toBe(18);

    // Capital formation/depreciation is physical: no money owner or unrelated inventory moves.
    expect(nextUnit.wallet).toBe(openingWallet);
    expect(nextUnit.inputInventory).toBe(openingInput);
    expect(nextUnit.outputInventory).toBe(openingOutput);
    expect(world.productionUnits.get(unit.productionUnitId)).toBe(unit);
    expect(unit.installedCapital).toBe(10);
    expect(unit.investmentInventory.get(TOOLS)).toBe(6);
    expect(unit.investmentInventory.get(IRON)).toBe(8);
  });

  it("clamps a within-epsilon decimal-ratio overshoot to zero stock without rejecting valid capital", () => {
    const recipe = capitalRecipe({
      investmentGoodsPerCapitalUnit: { [TOOLS]: 0.3 } as Readonly<Record<GoodId, number>>,
      depreciationRatePerTick: 0,
    });
    const { world, unit } = oneUnitWorld({ recipe, investment: [[TOOLS, 0.7]] });

    const execution = planCapitalFormationPhase12({ world, tick: 2 }).executions[0]!;
    expect(execution.capitalBuilt).toBe(0.7 / 0.3);
    expect(execution.investmentGoodsConsumedByGood[TOOLS]).toBe(0.7);

    const nextWorld = applyCapitalFormationTransition(world, [execution]);
    expect(nextWorld.productionUnits.get(unit.productionUnitId)!.investmentInventory.get(TOOLS)).toBe(0);
    expect(world.productionUnits.get(unit.productionUnitId)!.investmentInventory.get(TOOLS)).toBe(0.7);
  });

  it("rejects a genuine investment-stock overdraw instead of hiding it behind quantity epsilon", () => {
    const recipe = capitalRecipe({
      investmentGoodsPerCapitalUnit: { [TOOLS]: 0.3 } as Readonly<Record<GoodId, number>>,
      depreciationRatePerTick: 0,
    });
    const { world } = oneUnitWorld({ recipe, investment: [[TOOLS, 0.7]] });
    const execution = planCapitalFormationPhase12({ world, tick: 2 }).executions[0]!;
    const overdrawn: CapitalFormationExecution = {
      ...execution,
      investmentGoodsConsumedByGood: {
        ...execution.investmentGoodsConsumedByGood,
        [TOOLS]: 0.7 + 2e-9,
      },
    };

    expect(() => applyCapitalFormationTransition(world, [overdrawn])).toThrow(
      /does not match current authoritative stock\/evidence|over-consumes/,
    );
  });

  it("keeps incomplete investment bundles as inventory instead of creating capital", () => {
    const recipe = capitalRecipe({ depreciationRatePerTick: 0 });
    const { world, unit } = oneUnitWorld({
      recipe,
      investment: [[TOOLS, 100], [IRON, 0]],
    });

    const execution = planCapitalFormationPhase12({ world, tick: 3 }).executions[0]!;
    expect(execution.possibleCapitalFromGoods).toBe(0);
    expect(execution.capitalBuilt).toBe(0);
    expect(execution.investmentGoodsConsumedByGood).toEqual({
      [IRON]: 0,
      [TOOLS]: 0,
    });

    const nextWorld = applyCapitalFormationTransition(world, [execution]);
    const nextUnit = nextWorld.productionUnits.get(unit.productionUnitId)!;
    expect(nextUnit.installedCapital).toBe(unit.installedCapital);
    expect(nextUnit.investmentInventory.get(TOOLS)).toBe(100);
    expect(nextUnit.investmentInventory.get(IRON)).toBe(0);
  });

  it("depreciates existing capital even when a recipe has no investment-good conversion", () => {
    const recipe = {
      ...baselineDefinitionPack.recipes["recipe:food-harvest"]!,
      depreciationRatePerTick: 0.1,
    };
    const { world } = oneUnitWorld({ recipe, installedCapital: 20, investment: [[TOOLS, 7]] });

    const execution = planCapitalFormationPhase12({ world, tick: 4 }).executions[0]!;
    expect(execution.openingInvestmentQuantityByGood).toEqual({});
    expect(execution.possibleCapitalFromGoods).toBe(0);
    expect(execution.capitalBuilt).toBe(0);
    expect(execution.investmentGoodsConsumedByGood).toEqual({});
    expect(execution.depreciationUnits).toBe(2);
    expect(execution.installedCapitalNext).toBe(18);
  });

  it("rejects re-applying stale Phase-12 evidence so formation and depreciation cannot run twice", () => {
    const { world } = oneUnitWorld();
    const execution = planCapitalFormationPhase12({ world, tick: 7 }).executions[0]!;
    const nextWorld = applyCapitalFormationTransition(world, [execution]);

    expect(() => applyCapitalFormationTransition(nextWorld, [execution])).toThrow(
      /does not match current authoritative stock\/evidence/,
    );
    expect(() =>
      applyCapitalFormationTransition(world, [{ ...execution, capitalBuilt: execution.capitalBuilt + 1 }]),
    ).toThrow(/does not match current authoritative stock\/evidence/);
  });

  it("fails closed when the transition omits a unit that must receive Phase-12 depreciation", () => {
    const { world } = oneUnitWorld();
    expect(() => applyCapitalFormationTransition(world, [])).toThrow(/must cover every ProductionUnit/);
  });

  it("is deterministic under investment-inventory and ProductionUnit insertion reordering", () => {
    const first = oneUnitWorld({ investment: [[TOOLS, 6], [IRON, 8]] });
    const firstUnit = first.unit;
    const secondUnit: ProductionUnitState = {
      ...firstUnit,
      productionUnitId: "production-unit:zz-test" as ProductionUnitId,
      investmentInventory: new Map([[IRON, 12], [TOOLS, 10]]),
      installedCapital: 4,
    };

    const forward: WorldState = {
      ...first.world,
      productionUnits: new Map([
        [firstUnit.productionUnitId, firstUnit],
        [secondUnit.productionUnitId, secondUnit],
      ]),
    };
    const reverse: WorldState = {
      ...first.world,
      productionUnits: new Map([
        [secondUnit.productionUnitId, { ...secondUnit, investmentInventory: new Map([[TOOLS, 10], [IRON, 12]]) }],
        [firstUnit.productionUnitId, { ...firstUnit, investmentInventory: new Map([[IRON, 8], [TOOLS, 6]]) }],
      ]),
    };

    expect(normalizedExecutions(reverse)).toEqual(normalizedExecutions(forward));
  });

  it("records Phase-12 evidence in TickContext without mutating the world or emitting money transactions", () => {
    const { world, unit, recipe } = oneUnitWorld({ recipe: capitalRecipe({ depreciationRatePerTick: 0 }) });
    const handler = createPhase12CapitalFormationHandler();
    const beforeCapacity = deriveNameplateCapacity(unit, recipe);
    const context = { ...initializeTickContext(5, world.seed), phase: 12 };

    const after = handler(world, context, world.pendingTransitions);
    expect(after.capitalFormationExecutions).toHaveLength(1);
    expect(after.transactions).toEqual([]);
    expect(world.productionUnits.get(unit.productionUnitId)!.installedCapital).toBe(10);
    expect(deriveNameplateCapacity(world.productionUnits.get(unit.productionUnitId)!, recipe)).toBe(beforeCapacity);

    const persisted = applyCapitalFormationTransition(world, after.capitalFormationExecutions!);
    expect(
      deriveNameplateCapacity(persisted.productionUnits.get(unit.productionUnitId)!, recipe),
    ).toBeGreaterThan(beforeCapacity);

    const phase5Context = { ...initializeTickContext(5, world.seed), phase: 5 };
    expect(handler(world, phase5Context, world.pendingTransitions)).toBe(phase5Context);
  });

  it("rejects non-finite stock and invalid investment/depreciation coefficients", () => {
    const nonFinite = oneUnitWorld({ investment: [[TOOLS, Number.NaN], [IRON, 8]] });
    expect(() => planCapitalFormationPhase12({ world: nonFinite.world, tick: 1 })).toThrow(
      /INVESTMENT.*must be finite/,
    );

    const zeroCoefficient = oneUnitWorld({
      recipe: capitalRecipe({
        investmentGoodsPerCapitalUnit: { [TOOLS]: 0 } as Readonly<Record<GoodId, number>>,
      }),
    });
    expect(() => planCapitalFormationPhase12({ world: zeroCoefficient.world, tick: 1 })).toThrow(
      /investmentGoodsPerCapitalUnit.*must be > 0/,
    );

    const badDepreciation = oneUnitWorld({ recipe: capitalRecipe({ depreciationRatePerTick: 1 }) });
    expect(() => planCapitalFormationPhase12({ world: badDepreciation.world, tick: 1 })).toThrow(
      /depreciationRatePerTick must be in \[0,1\)/,
    );
  });
});
