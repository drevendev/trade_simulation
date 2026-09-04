import { describe, expect, it } from "vitest";

import { createIdAllocator, type RegionId } from "./id";
import { sortByPersistentId, stableOrderBy } from "./ordering";

interface RegionRecord {
  readonly id: RegionId;
  readonly name: string;
}

describe("stableOrderBy", () => {
  it("produces an identical normalized result regardless of input iteration order (CORE-T2)", () => {
    const allocator = createIdAllocator();
    const alpha: RegionRecord = { id: allocator.allocate("Region", "alpha"), name: "alpha" };
    const beta: RegionRecord = { id: allocator.allocate("Region", "beta"), name: "beta" };
    const gamma: RegionRecord = { id: allocator.allocate("Region", "gamma"), name: "gamma" };
    const delta: RegionRecord = { id: allocator.allocate("Region", "delta"), name: "delta" };

    // Two differently-shuffled views of the same logical set, as if built from
    // a Map/object whose iteration order differs from insertion or from each other.
    const shuffledA = [gamma, alpha, delta, beta];
    const shuffledB = [beta, delta, alpha, gamma];

    const orderedA = stableOrderBy(shuffledA, (r) => r.id);
    const orderedB = stableOrderBy(shuffledB, (r) => r.id);

    expect(orderedA).toEqual(orderedB);
    // Allocated in this order, so ids are r:1 (alpha) .. r:4 (delta): sorting by
    // id ascending reproduces allocation order regardless of the shuffle.
    expect(orderedA.map((r) => r.name)).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("actually reorders — a no-op or identity implementation would fail the above assertion", () => {
    const allocator = createIdAllocator();
    // Allocated first, so it gets the lexicographically-smaller id (r:1).
    const smallerId: RegionRecord = {
      id: allocator.allocate("Region", "allocated-first"),
      name: "allocated-first",
    };
    // Allocated second (r:2), but placed *before* smallerId in the input array —
    // insertion order is the reverse of id order.
    const largerId: RegionRecord = {
      id: allocator.allocate("Region", "allocated-second"),
      name: "allocated-second",
    };
    const insertionOrder: RegionRecord[] = [largerId, smallerId];

    const ordered = stableOrderBy(insertionOrder, (r) => r.id);

    expect(ordered.map((r) => r.name)).toEqual(["allocated-first", "allocated-second"]);
    expect(ordered).not.toEqual(insertionOrder);
  });

  it("does not mutate the input array", () => {
    const allocator = createIdAllocator();
    const one: RegionRecord = { id: allocator.allocate("Region", "one"), name: "one" };
    const two: RegionRecord = { id: allocator.allocate("Region", "two"), name: "two" };
    const original = [two, one];
    const snapshot = [...original];

    stableOrderBy(original, (r) => r.id);

    expect(original).toEqual(snapshot);
  });

  it("is stable: equal keys preserve their relative input order", () => {
    const items = [
      { key: "x", tag: "first" },
      { key: "x", tag: "second" },
      { key: "x", tag: "third" },
    ];

    const ordered = stableOrderBy(items, (item) => item.key);

    expect(ordered.map((item) => item.tag)).toEqual(["first", "second", "third"]);
  });
});

describe("sortByPersistentId", () => {
  it("sorts ID-bearing records by their persistent ID, independent of build order", () => {
    const allocator = createIdAllocator();
    const records: RegionRecord[] = [
      { id: allocator.allocate("Region", "north"), name: "north" },
      { id: allocator.allocate("Region", "south"), name: "south" },
      { id: allocator.allocate("Region", "east"), name: "east" },
    ];

    const fromMapInsertionOrder = new Map(records.map((r) => [r.id, r]));
    const fromReversedInsertionOrder = new Map([...records].reverse().map((r) => [r.id, r]));

    const orderedFromMap = sortByPersistentId([...fromMapInsertionOrder.values()]);
    const orderedFromReversed = sortByPersistentId([...fromReversedInsertionOrder.values()]);

    expect(orderedFromMap).toEqual(orderedFromReversed);
    // Allocated in this order, so ids are r:1 (north), r:2 (south), r:3 (east):
    // sorting by id ascending reproduces the allocation order regardless of the
    // Map's own iteration order.
    expect(orderedFromMap.map((r) => r.name)).toEqual(["north", "south", "east"]);
  });
});
