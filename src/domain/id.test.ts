import { describe, expect, it } from "vitest";

import {
  allocateInCreationKeyOrder,
  createIdAllocator,
  ID_KIND_PREFIX,
  type IdKind,
  type StateId,
} from "./id";

describe("id kind prefixes", () => {
  it("defines exactly the 13 kinds named by CORE_SCHEMA_AND_LIFECYCLES section 2", () => {
    expect(ID_KIND_PREFIX).toEqual({
      Region: "r",
      State: "s",
      Clan: "c",
      Cohort: "pc",
      ProductionUnit: "pu",
      Market: "m",
      TransportLink: "tl",
      Currency: "cur",
      MonetaryAuthority: "ma",
      Shipment: "sh",
      Bond: "bond",
      EventInstance: "ev",
      Good: "good",
    });
    expect(Object.keys(ID_KIND_PREFIX)).toHaveLength(13);
  });

  it("allocates every kind as `${prefix}:${sequence}`", () => {
    const allocator = createIdAllocator();
    for (const kind of Object.keys(ID_KIND_PREFIX) as IdKind[]) {
      const id = allocator.allocate(kind, `${kind}-only-entity`);
      expect(id).toBe(`${ID_KIND_PREFIX[kind]}:1`);
    }
  });
});

describe("allocation is never an array index or map-order artifact", () => {
  it("increments a per-kind sequence independent of other kinds", () => {
    const allocator = createIdAllocator();
    expect(allocator.allocate("Region", "region-alpha")).toBe("r:1");
    expect(allocator.allocate("State", "state-alpha")).toBe("s:1");
    expect(allocator.allocate("Region", "region-beta")).toBe("r:2");
    expect(allocator.allocate("State", "state-beta")).toBe("s:2");
    expect(allocator.allocate("Region", "region-gamma")).toBe("r:3");
  });

  it("rejects a duplicate creation key without corrupting the sequence", () => {
    const allocator = createIdAllocator();
    allocator.allocate("Region", "region-alpha");

    expect(() => allocator.allocate("Region", "region-alpha")).toThrow(/duplicate creation key/);

    // The rejected call must not have consumed a sequence number.
    expect(allocator.allocate("Region", "region-beta")).toBe("r:2");
  });

  it("rejects an empty creation key", () => {
    const allocator = createIdAllocator();
    expect(() => allocator.allocate("Region", "")).toThrow(/non-empty/);
  });

  it("rejects an unknown id kind before allocating anything", () => {
    const allocator = createIdAllocator();
    expect(() => allocator.allocate("Unknown" as unknown as IdKind, "x")).toThrow(/unknown id kind/);
    // Must not have consumed a sequence number for any kind.
    expect(allocator.allocate("Region", "region-alpha")).toBe("r:1");
  });

  it("rejects an id kind that is only an inherited Object.prototype property", () => {
    const allocator = createIdAllocator();
    for (const prototypeKey of ["constructor", "toString", "hasOwnProperty"]) {
      expect(() => allocator.allocate(prototypeKey as unknown as IdKind, "x")).toThrow(
        /unknown id kind/,
      );
    }
  });

  it("rejects a non-string creation key without mutating allocator state", () => {
    const allocator = createIdAllocator();
    expect(() => allocator.allocate("Region", 123 as unknown as string)).toThrow(/non-empty string/);
    expect(allocator.allocate("Region", "region-alpha")).toBe("r:1");
  });
});

describe("deterministic replay across independent runs", () => {
  it("produces identical IDs from two independent allocators given the same call sequence", () => {
    const creationKeys = ["region-alpha", "region-beta", "region-gamma", "region-delta"];

    const runA = createIdAllocator();
    const runB = createIdAllocator();

    const idsFromA = creationKeys.map((key) => runA.allocate("Region", key));
    const idsFromB = creationKeys.map((key) => runB.allocate("Region", key));

    expect(idsFromB).toEqual(idsFromA);
  });

  it("keeps allocator state independent per instance — no shared module singleton", () => {
    const runA = createIdAllocator();
    const runB = createIdAllocator();

    // The same creation key in two independent allocators is not a duplicate:
    // if state were shared, the second call would throw.
    expect(runA.allocate("Region", "region-alpha")).toBe("r:1");
    expect(runB.allocate("Region", "region-alpha")).toBe("r:1");
  });
});

describe("stable creation-key order contract", () => {
  it("assigns the same key-to-ID mapping regardless of input array order", () => {
    const inOrderKeys = ["region-alpha", "region-beta", "region-gamma", "region-delta"];
    const shuffledKeys = ["region-gamma", "region-alpha", "region-delta", "region-beta"];

    const runA = createIdAllocator();
    const runB = createIdAllocator();

    const mappingFromInOrder = allocateInCreationKeyOrder(runA, "Region", inOrderKeys);
    const mappingFromShuffled = allocateInCreationKeyOrder(runB, "Region", shuffledKeys);

    expect(Object.fromEntries(mappingFromShuffled)).toEqual(Object.fromEntries(mappingFromInOrder));
    // Ascending lexicographic order: alpha < beta < delta < gamma.
    expect(mappingFromInOrder.get("region-alpha")).toBe("r:1");
    expect(mappingFromInOrder.get("region-beta")).toBe("r:2");
    expect(mappingFromInOrder.get("region-delta")).toBe("r:3");
    expect(mappingFromInOrder.get("region-gamma")).toBe("r:4");
  });

  it("rejects an in-batch duplicate creation key without reserving any of the batch", () => {
    const allocator = createIdAllocator();

    expect(() => allocateInCreationKeyOrder(allocator, "Region", ["alpha", "alpha"])).toThrow(
      /duplicate creation key/,
    );

    expect(allocator.isAllocated("r:1")).toBe(false);
    expect(allocator.hasCreationKey("Region", "alpha")).toBe(false);
    // Numbering must be unaffected by the rejected batch.
    expect(allocator.allocate("Region", "beta")).toBe("r:1");
  });

  it("rejects a batch key that overlaps a creation key already used by this allocator, including a retired one", () => {
    const allocator = createIdAllocator();
    const priorId = allocator.allocate("Region", "region-alpha");
    allocator.retire("Region", priorId);

    expect(() =>
      allocateInCreationKeyOrder(allocator, "Region", ["region-beta", "region-alpha"]),
    ).toThrow(/already used/);

    // Neither key in the batch was reserved: no r:2 was consumed.
    expect(allocator.hasCreationKey("Region", "region-beta")).toBe(false);
    expect(allocator.allocate("Region", "region-beta")).toBe("r:2");
  });

  it("rejects a batch containing a non-string creation key without reserving any of the batch", () => {
    const allocator = createIdAllocator();

    expect(() =>
      allocateInCreationKeyOrder(allocator, "Region", ["alpha", 123 as unknown as string]),
    ).toThrow(/non-empty string/);

    expect(allocator.hasCreationKey("Region", "alpha")).toBe(false);
    expect(allocator.allocate("Region", "alpha")).toBe("r:1");
  });

  it("rejects an unknown id kind for the batch helper before reserving anything", () => {
    const allocator = createIdAllocator();

    expect(() =>
      allocateInCreationKeyOrder(allocator, "Unknown" as unknown as IdKind, ["alpha"]),
    ).toThrow(/unknown id kind/);

    expect(allocator.allocate("Region", "alpha")).toBe("r:1");
  });

  it("is unaffected by the iteration order of a Map the caller built differently", () => {
    const builtForward = new Map([
      ["region-alpha", 1],
      ["region-beta", 2],
      ["region-gamma", 3],
    ]);
    const builtBackward = new Map([
      ["region-gamma", 3],
      ["region-beta", 2],
      ["region-alpha", 1],
    ]);

    const runA = createIdAllocator();
    const runB = createIdAllocator();

    const mappingForward = allocateInCreationKeyOrder(runA, "Region", builtForward.keys());
    const mappingBackward = allocateInCreationKeyOrder(runB, "Region", builtBackward.keys());

    expect(Object.fromEntries(mappingBackward)).toEqual(Object.fromEntries(mappingForward));
  });
});

describe("retirement and non-reuse (CORE-T16)", () => {
  it("gives a retired entity's successor a distinct ID and never rebinds the old one", () => {
    const allocator = createIdAllocator();

    const idA = allocator.allocate("Cohort", "cohort-lower-working-region-alpha");
    allocator.retire("Cohort", idA);
    const idB = allocator.allocate("Cohort", "cohort-lower-working-region-alpha-successor");

    expect(idB).not.toBe(idA);
    expect(allocator.isRetired(idA)).toBe(true);
    expect(allocator.isRetired(idB)).toBe(false);
  });

  it("never reuses a retired ID even after many further allocations", () => {
    const allocator = createIdAllocator();
    const idA = allocator.allocate("ProductionUnit", "pu-alpha");
    allocator.retire("ProductionUnit", idA);

    const laterIds = Array.from({ length: 50 }, (_, i) =>
      allocator.allocate("ProductionUnit", `pu-later-${i}`),
    );

    expect(laterIds).not.toContain(idA);
  });

  it("rejects retiring an ID that was never allocated", () => {
    const allocator = createIdAllocator();
    expect(() => allocator.retire("Region", "r:999" as unknown as never)).toThrow(
      /never allocated/,
    );
  });

  it("rejects retiring the same ID twice, and the second attempt does not corrupt state", () => {
    const allocator = createIdAllocator();
    const id = allocator.allocate("Market", "market-alpha");
    allocator.retire("Market", id);

    expect(() => allocator.retire("Market", id)).toThrow(/already retired/);
    expect(allocator.isRetired(id)).toBe(true);
  });

  it("rejects retiring an ID under the wrong kind and does not mark it retired", () => {
    const allocator = createIdAllocator();
    const regionId = allocator.allocate("Region", "region-alpha");

    expect(() =>
      allocator.retire("State", regionId as unknown as StateId),
    ).toThrow(/does not belong to id kind "State"/);
    expect(allocator.isRetired(regionId)).toBe(false);
  });

  it("distinguishes allocated-and-live, retired, and never-allocated IDs", () => {
    const allocator = createIdAllocator();
    const live = allocator.allocate("Currency", "currency-alpha");
    const retired = allocator.allocate("Currency", "currency-beta");
    allocator.retire("Currency", retired);

    expect(allocator.isAllocated(live)).toBe(true);
    expect(allocator.isRetired(live)).toBe(false);

    expect(allocator.isAllocated(retired)).toBe(true);
    expect(allocator.isRetired(retired)).toBe(true);

    expect(allocator.isAllocated("cur:999")).toBe(false);
    expect(allocator.isRetired("cur:999")).toBe(false);
  });
});
