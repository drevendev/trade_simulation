/**
 * M5 / #673: derive owner-backed actor resource ceilings for Phase-7 planning.
 *
 * This is a pure read of current physical inventory and cash. It does not
 * authorize a trade, commit a reserve or replace the Phase-4 residual intents:
 * matching and the atomic dispatcher still revalidate every economic leg.
 * The protected stock per physical seller endpoint is an explicit caller-owned
 * post-earlier-commit quantity, not a second implicit economic default.
 */
import type { WorldState } from "./worldState";
import { validateMarketIntent } from "./marketIntent";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import {
  phase7BuyerActorCashKey,
  phase7SellerEndpointKey,
  type Phase7ActorMatchBudgets,
} from "./phase7IntentMatching";
import type { Phase7TradePlanActors } from "./phase7TradePlan";

function nonnegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(label + " must be finite and non-negative");
  }
}

/**
 * Derive unique actor endpoint balances once, even when multiple plans refer to
 * the same seller bucket or buyer wallet. The caller MUST explicitly provide
 * non-exportable stock for every referenced seller endpoint (zero is explicit).
 * This guards against counting the same physical stock multiple times.
 *
 * A prior Phase-4 commitment remains represented by the residual MarketIntents
 * and spend limits passed separately to matchPhase7ActorIntents.
 */
export function buildPhase7LiveActorMatchBudgets(
  world: WorldState,
  actorsByTradePlanId: ReadonlyMap<string, Phase7TradePlanActors>,
  protectedSellerQuantityByEndpoint: ReadonlyMap<string, number>,
): Phase7ActorMatchBudgets {
  const sellerEvidence = new Map<string, Phase7TradePlanActors["sellers"][number]["intent"]>();
  const buyerEvidence = new Map<string, {
    actor: Phase7TradePlanActors["buyers"][number]["intent"]["actor"];
    currencyId: NonNullable<ReturnType<typeof world.regions.get>>["settlementCurrencyId"];
  }>();

  for (const [, actors] of [...actorsByTradePlanId].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0)) {
    for (const seller of actors.sellers) {
      validateMarketIntent(seller.intent);
      if (seller.intent.side !== "SELL" || !world.regions.has(seller.intent.regionId)) {
        throw new Error("Phase-7 live seller must reference a known SELL region");
      }
      sellerEvidence.set(phase7SellerEndpointKey(seller.intent), seller.intent);
    }
    for (const buyer of actors.buyers) {
      validateMarketIntent(buyer.intent);
      const region = world.regions.get(buyer.intent.regionId);
      if (buyer.intent.side !== "BUY" || !region) {
        throw new Error("Phase-7 live buyer must reference a known BUY region");
      }
      const currencyId = region.settlementCurrencyId;
      buyerEvidence.set(phase7BuyerActorCashKey(buyer.intent.actor, currencyId), {
        actor: buyer.intent.actor, currencyId,
      });
    }
  }

  // The same canonical absolute quantity tolerance used by the Phase-7 actor
  // matcher. Reject missing/invalid config rather than inventing another rule.
  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon;
  if (quantityEpsilon === undefined || !Number.isFinite(quantityEpsilon) || quantityEpsilon < 0) {
    throw new Error("Phase-7 live seller requires resolved quantity epsilon");
  }
  const sellerExportableByEndpoint = new Map<string, number>();
  for (const [key, intent] of [...sellerEvidence].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!protectedSellerQuantityByEndpoint.has(key)) {
      throw new Error("Phase-7 live seller missing explicit protected stock for " + key);
    }
    const physical = readMarketActorInventory(
      world, intent.actor, intent.inventoryBucket ?? "GENERAL", "seller",
    ).get(intent.goodId) ?? 0;
    const protectedQuantity = protectedSellerQuantityByEndpoint.get(key)!;
    nonnegativeFinite(physical, "live seller stock");
    nonnegativeFinite(protectedQuantity, "protected seller stock");
    if (protectedQuantity > physical) {
      throw new Error("Phase-7 protected seller stock exceeds live inventory");
    }
    const exportable = physical - protectedQuantity;
    // Binary64 round trips like 9 - 8.9 may differ from 0.1 by a few ulps.
    // Allow only the canonical quantity epsilon of harmless rounding; still
    // refuse unobservable or materially misrepresented debits (1e16 - 3 = 4).
    const observableProtected = physical - exportable;
    if (!Number.isFinite(exportable) ||
        (protectedQuantity > 0 &&
          (exportable === physical ||
           Math.abs(observableProtected - protectedQuantity) > quantityEpsilon))) {
      throw new Error("Phase-7 seller exportable quantity lost numeric precision");
    }
    sellerExportableByEndpoint.set(key, exportable);
  }

  const buyerCashByActorCurrency = new Map<string, number>();
  for (const [key, buyer] of [...buyerEvidence].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const cash = readActorWallet(world, buyer.actor).get(buyer.currencyId) ?? 0;
    nonnegativeFinite(cash, "live buyer cash");
    buyerCashByActorCurrency.set(key, cash);
  }

  return { sellerExportableByEndpoint, buyerCashByActorCurrency };
}
