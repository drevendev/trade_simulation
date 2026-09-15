/**
 * Definitions registry (REQ-CORE-003).
 *
 * See `docs/spec/mirror/06 - Handoff/01 — CORE_SCHEMA_AND_LIFECYCLES.md`
 * section 6: `DefinitionRegistry` holds immutable, scenario-versioned
 * content/reference definitions distinct from live world-entity instances —
 * `goods`, `recipes`, `eventDefinitions`, `metricDefinitions`. Section 4 of
 * `06 - Handoff/06 — POPULATION_DEMOGRAPHY_CLANS_CONTRACTS.md` names one more
 * on this same registry, `DefinitionRegistry.needCategories` (REQ-CONFIG-007).
 * `DefinitionPack` (`REQ-CONFIG-001`, `../config/definitionPack.ts`) declares
 * exactly these five fields with matching key/value shapes, so this registry is
 * a typed, read-only view over a `DefinitionPack` rather than new storage.
 *
 * Every definitions field of the pack belongs in the projection below. A field
 * validated by `validateDefinitionPack()` and then left out of it is discarded
 * at genesis: the pack is not reachable from `WorldState`, so a reader inside
 * the simulation would have no canonical source for it. `needCategories` was in
 * exactly that state when it was added to the pack without being added here.
 */
import type { DefinitionPack } from "../config/definitionPack";
import type { GoodId } from "./id";

export type DefinitionRegistry = Pick<
  DefinitionPack,
  "goods" | "recipes" | "eventDefinitions" | "metricDefinitions" | "needCategories"
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
 *
 * The filter below is defence-in-depth, not the rule. `validateDefinitionPack()`
 * (`REQ-CONFIG-005`, `../config/validation.ts`) is authoritative and rejects a
 * non-finite, zero, negative or unknown-good coefficient before `buildInitialWorld()`
 * runs, so on the genesis path the filter can no longer discard anything. It is kept
 * because this resolver is also reachable from a registry assembled without that
 * validation, and because both the emitting and the reconciling side call it: loosening
 * it on one side only would let them disagree. It is deliberately not an assertion —
 * raising here would move the diagnostic away from the validator that can name the
 * offending pack, and would change the behavior of callers that never validated.
 * Anything it drops is a configuration defect that validation should have caught
 * (Issue #465).
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

/**
 * Builds the definitions registry from `definitionPack`, unchanged.
 *
 * `needCategories` is optional on the pack and stays optional here: a pack that
 * declares none produces a registry with none, and none is never replaced by an
 * empty object, so "declares no categories" and "declares zero categories" do not
 * become the same state at the boundary.
 *
 * The conditional spread is what `exactOptionalPropertyTypes` requires — writing
 * the key with an `undefined` value is not the same as leaving it out, and only
 * leaving it out keeps an absent field absent across the projection.
 */
export function buildDefinitionRegistry(definitionPack: DefinitionPack): DefinitionRegistry {
  return {
    goods: definitionPack.goods,
    recipes: definitionPack.recipes,
    eventDefinitions: definitionPack.eventDefinitions,
    metricDefinitions: definitionPack.metricDefinitions,
    ...(definitionPack.needCategories === undefined ? {} : { needCategories: definitionPack.needCategories }),
  };
}
