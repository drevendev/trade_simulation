/**
 * Definitions registry (REQ-CORE-003).
 *
 * See `docs/spec/mirror/06 - Handoff/01 — CORE_SCHEMA_AND_LIFECYCLES.md`
 * section 6: `DefinitionRegistry` holds immutable, scenario-versioned
 * content/reference definitions distinct from live world-entity instances —
 * `goods`, `recipes`, `eventDefinitions`, `metricDefinitions`. `DefinitionPack`
 * (`REQ-CONFIG-001`, `../config/definitionPack.ts`) already declares exactly
 * these four fields with matching key/value shapes, so this registry is a
 * typed, read-only view over a `DefinitionPack` rather than new storage.
 */
import type { DefinitionPack } from "../config/definitionPack";
import type { GoodId } from "./id";

export type DefinitionRegistry = Pick<
  DefinitionPack,
  "goods" | "recipes" | "eventDefinitions" | "metricDefinitions"
>;

/**
 * The documented capital conversion for one recipe: the capital goods a unit of
 * installed capital embodies, as `[goodId, goodsPerCapitalUnit]` pairs with a
 * strictly positive coefficient.
 *
 * Genesis capital accounting (`REQ-CONFIG-004`, Handoff/03 section 20) and any later
 * reader of the same conversion resolve it here, so the emitting and reconciling
 * sides cannot drift apart. An empty result means the recipe declares no investment
 * good: its capital embodies no tradable good.
 */
export function resolveCapitalGoodsPerCapitalUnit(
  definitions: DefinitionRegistry,
  recipeId: string,
): readonly (readonly [GoodId, number])[] {
  const recipe = definitions.recipes[recipeId];
  if (!recipe) return [];

  return Object.entries(recipe.investmentGoodsPerCapitalUnit ?? {})
    .filter(([, goodsPerCapitalUnit]) => Number.isFinite(goodsPerCapitalUnit) && goodsPerCapitalUnit > 0)
    .map(([goodKey, goodsPerCapitalUnit]) => [goodKey as GoodId, goodsPerCapitalUnit] as const);
}

/** Builds the definitions registry from `definitionPack`, unchanged. */
export function buildDefinitionRegistry(definitionPack: DefinitionPack): DefinitionRegistry {
  return {
    goods: definitionPack.goods,
    recipes: definitionPack.recipes,
    eventDefinitions: definitionPack.eventDefinitions,
    metricDefinitions: definitionPack.metricDefinitions,
  };
}
