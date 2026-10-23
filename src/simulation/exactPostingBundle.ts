/**
 * Pure, non-authoritative posting preflight for HANDOFF-REPAIR-M4-009 / #798.
 *
 * This stages exact owner/bucket/asset deltas without changing WorldState, allocating
 * transaction IDs, or activating stockEncodingVersion=2. A later gated integration
 * must bind readOpening to canonical WorldState endpoints and commit the returned
 * postings and EconomicTransaction journal as one atomic effect.
 */
import type { CurrencyId, GoodId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { actorRefKey } from "../domain/genesisLedger";
import {
  EXACT_ZERO,
  assertFiniteExactMagnitude,
  assertPhysicalExactStock,
  exactAdd,
  exactCompare,
  type ExactStockAmount,
} from "../domain/exactStockAmount";

export type ExactPostingEndpoint =
  | {
      readonly kind: "MONEY";
      readonly owner: ActorRef;
      readonly bucket: "WALLET" | "TREASURY";
      readonly currencyId: CurrencyId;
    }
  | {
      readonly kind: "GOOD";
      readonly owner: ActorRef;
      readonly bucket: "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";
      readonly goodId: GoodId;
    };

export interface ExactPostingLeg {
  /** Stable, unique identity within this bundle for later journal auditing. */
  readonly legId: string;
  readonly endpoint: ExactPostingEndpoint;
  /** Signed amount; a debit is negative, a credit positive. */
  readonly delta: ExactStockAmount;
}

export interface StagedExactEndpoint {
  readonly endpoint: ExactPostingEndpoint;
  readonly opening: ExactStockAmount;
  readonly closing: ExactStockAmount;
  /** Original ordered legs retained for future per-leg journal reconciliation. */
  readonly legs: readonly ExactPostingLeg[];
}

interface MutableStage {
  readonly endpoint: ExactPostingEndpoint;
  readonly opening: ExactStockAmount;
  closing: ExactStockAmount;
  readonly legs: ExactPostingLeg[];
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`exact posting: invalid ${label}`);
  }
  return value;
}

/** Reject actors/buckets that do not correspond to one physical M4 stock. */
function endpointKey(endpoint: ExactPostingEndpoint): { key: string; assetKey: string } {
  if (typeof endpoint !== "object" || endpoint === null ||
      typeof endpoint.owner !== "object" || endpoint.owner === null) {
    throw new Error("exact posting: missing owner/endpoint");
  }
  const owner = endpoint.owner;
  // Validate the original typed ID before actorRefKey can stringify null/missing
  // fields into plausible-looking "COHORT:undefined" / "PU:null" owner keys.
  let rawOwnerId: unknown;
  switch (owner.type) {
    case "COHORT": rawOwnerId = owner.cohortId; break;
    case "CLAN": rawOwnerId = owner.clanId; break;
    case "STATE": rawOwnerId = owner.stateId; break;
    case "PRODUCTION_UNIT": rawOwnerId = owner.productionUnitId; break;
    case "MONETARY_AUTHORITY": rawOwnerId = owner.authorityId; break;
    default: throw new Error("exact posting: unknown owner kind");
  }
  requiredId(rawOwnerId, "owner ID");
  const ownerId = actorRefKey(owner);

  if (endpoint.kind === "MONEY") {
    const expected = owner.type === "STATE" || owner.type === "CLAN" ? "TREASURY" : "WALLET";
    if (owner.type === "MONETARY_AUTHORITY" || endpoint.bucket !== expected) {
      throw new Error("exact posting: owner has no authorized money bucket");
    }
    const currencyId = requiredId(endpoint.currencyId, "currency ID");
    return {
      key: JSON.stringify(["MONEY", ownerId, endpoint.bucket, currencyId]),
      assetKey: JSON.stringify(["MONEY", currencyId]),
    };
  }

  if (endpoint.kind === "GOOD") {
    const validBucket = owner.type === "PRODUCTION_UNIT"
      ? endpoint.bucket === "INPUT" || endpoint.bucket === "OUTPUT" || endpoint.bucket === "INVESTMENT"
      : (owner.type === "COHORT" || owner.type === "STATE") && endpoint.bucket === "GENERAL";
    if (!validBucket) {
      throw new Error("exact posting: owner has no authorized goods bucket");
    }
    const goodId = requiredId(endpoint.goodId, "good ID");
    return {
      key: JSON.stringify(["GOOD", ownerId, endpoint.bucket, goodId]),
      assetKey: JSON.stringify(["GOOD", goodId]),
    };
  }
  throw new Error("exact posting: unknown asset kind");
}

/**
 * Validate and stage a closed, same-asset conserving transfer bundle.
 *
 * All opening balances are read once per full owner/bucket/asset key. Alias legs
 * are applied in their original order, but only the FINAL amount is checked:
 * a self-transfer may temporarily debit and then credit the same endpoint.
 * Cross-asset/cross-currency offsets and implicit minting are forbidden here.
 *
 * The callback MUST only read opening balances; this function never writes them.
 * Economic mint/burn/loss requires a separate explicitly authorized typed path.
 */
export function stageExactPostingBundle(
  legs: readonly ExactPostingLeg[],
  readOpening: (endpoint: ExactPostingEndpoint) => ExactStockAmount,
): readonly StagedExactEndpoint[] {
  if (legs.length === 0) throw new Error("exact posting: empty bundle");

  const stages = new Map<string, MutableStage>();
  const assetTotals = new Map<string, ExactStockAmount>();
  const legIds = new Set<string>();

  for (const leg of legs) {
    const legId = requiredId(leg.legId, "leg ID");
    if (legIds.has(legId)) throw new Error(`exact posting: duplicate leg ID ${legId}`);
    legIds.add(legId);

    const { key, assetKey } = endpointKey(leg.endpoint);
    assertFiniteExactMagnitude(leg.delta);
    if (exactCompare(leg.delta, EXACT_ZERO) === 0) {
      throw new Error("exact posting: zero-valued journal leg");
    }

    let stage = stages.get(key);
    if (!stage) {
      const sourceOpening = readOpening(leg.endpoint);
      assertPhysicalExactStock(sourceOpening);
      // Detached snapshot: caller-owned objects may be mutable at runtime despite TS readonly.
      const opening: ExactStockAmount = Object.freeze({
        coefficient: sourceOpening.coefficient, exponent: sourceOpening.exponent,
      });
      const endpoint = Object.freeze({
        ...leg.endpoint, owner: Object.freeze({ ...leg.endpoint.owner }),
      }) as ExactPostingEndpoint;
      stage = { endpoint, opening, closing: opening, legs: [] };
      stages.set(key, stage);
    }
    const immutableLeg: ExactPostingLeg = Object.freeze({
      legId, endpoint: stage.endpoint,
      delta: Object.freeze({ coefficient: leg.delta.coefficient, exponent: leg.delta.exponent }),
    });
    stage.closing = exactAdd(stage.closing, immutableLeg.delta);
    stage.legs.push(immutableLeg);
    assetTotals.set(assetKey, exactAdd(assetTotals.get(assetKey) ?? EXACT_ZERO, immutableLeg.delta));
  }

  for (const [asset, total] of assetTotals) {
    if (exactCompare(total, EXACT_ZERO) !== 0) {
      throw new Error(`exact posting: unbalanced transfer of ${asset}`);
    }
  }
  for (const stage of stages.values()) assertPhysicalExactStock(stage.closing);

  // Stable full-tuple ordering, independent of Map construction/insertion order.
  return Object.freeze([...stages.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, stage]) => Object.freeze({
      endpoint: stage.endpoint,
      opening: stage.opening,
      closing: stage.closing,
      legs: Object.freeze([...stage.legs]),
    })));
}
