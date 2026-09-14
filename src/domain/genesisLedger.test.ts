/**
 * Tests for WorldGenesisLedger schema and types (REQ-CONFIG-004 Part 1/4).
 */

import { describe, it, expect } from "vitest";
import {
  createEmptyWorldGenesisLedger,
  addGenesisRecord,
  type GenesisRecord,
  type WorldGenesisLedger,
} from "./genesisLedger";
import { createIdAllocator } from "./id";

describe("WorldGenesisLedger", () => {
  it("creates an empty ledger", () => {
    const ledger = createEmptyWorldGenesisLedger();
    expect(ledger.records).toHaveLength(0);
    expect(Array.isArray(ledger.records)).toBe(true);
  });

  it("accepts money endowment records", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const clanId = allocator.allocate("Clan", "test-clan");

    const record: GenesisRecord = {
      type: "MONEY_ENDOWMENT",
      owner: { type: "CLAN", clanId },
      currencyId: allocator.allocate("Currency", "test-currency"),
      amount: 1000,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts good endowment records", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const stateId = allocator.allocate("State", "test-state");

    const record: GenesisRecord = {
      type: "GOOD_ENDOWMENT",
      owner: { type: "STATE", stateId },
      regionId: allocator.allocate("Region", "test-region"),
      goodId: allocator.allocate("Good", "test-good"),
      amount: 500,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts population endowment records", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const clanId = allocator.allocate("Clan", "test-clan");

    const record: GenesisRecord = {
      type: "POPULATION_ENDOWMENT",
      owner: { type: "CLAN", clanId },
      regionId: allocator.allocate("Region", "test-region"),
      amount: 100,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts capital endowment records", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const stateId = allocator.allocate("State", "test-state");

    const record: GenesisRecord = {
      type: "CAPITAL_ENDOWMENT",
      owner: { type: "STATE", stateId },
      regionId: allocator.allocate("Region", "test-region"),
      goodId: allocator.allocate("Good", "test-capital-good"),
      amount: 50,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts resource endowment records", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();

    const record: GenesisRecord = {
      type: "RESOURCE_ENDOWMENT",
      regionId: allocator.allocate("Region", "test-region"),
      goodId: allocator.allocate("Good", "test-resource"),
      amount: 10000,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts bond opening position records", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const stateId = allocator.allocate("State", "test-state");

    const record: GenesisRecord = {
      type: "BOND_OPENING_POSITION",
      owner: { type: "STATE", stateId },
      currencyId: allocator.allocate("Currency", "test-currency"),
      amount: 5000,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts FX pool opening records", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();

    const record: GenesisRecord = {
      type: "FX_POOL_OPENING",
      currencyId: allocator.allocate("Currency", "test-currency"),
      amount: 2000,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts money endowment records with ProductionUnit owner", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const productionUnitId = allocator.allocate("ProductionUnit", "test-pu");

    const record: GenesisRecord = {
      type: "MONEY_ENDOWMENT",
      owner: { type: "PRODUCTION_UNIT", productionUnitId },
      currencyId: allocator.allocate("Currency", "test-currency"),
      amount: 1000,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts good endowment records with ProductionUnit owner and a typed inventory bucket", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const productionUnitId = allocator.allocate("ProductionUnit", "test-pu");

    const record: GenesisRecord = {
      type: "GOOD_ENDOWMENT",
      owner: { type: "PRODUCTION_UNIT", productionUnitId },
      regionId: allocator.allocate("Region", "test-region"),
      goodId: allocator.allocate("Good", "test-good"),
      amount: 500,
      inventoryBucket: "INPUT",
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("records the same ProductionUnit good in two buckets as two distinct stocks", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const productionUnitId = allocator.allocate("ProductionUnit", "test-pu");
    const regionId = allocator.allocate("Region", "test-region");
    const goodId = allocator.allocate("Good", "test-good");
    const owner = { type: "PRODUCTION_UNIT" as const, productionUnitId };

    // Section 20: a unit's INPUT and OUTPUT inventories of the same good are two
    // authoritative stocks, so both records stand and neither replaces the other.
    const asInput: GenesisRecord = {
      type: "GOOD_ENDOWMENT",
      owner,
      regionId,
      goodId,
      amount: 80,
      inventoryBucket: "INPUT",
      sourceSeedKey: "test-pu.inputInventory.test-good",
    };
    const asOutput: GenesisRecord = {
      type: "GOOD_ENDOWMENT",
      owner,
      regionId,
      goodId,
      amount: 300,
      inventoryBucket: "OUTPUT",
      sourceSeedKey: "test-pu.outputInventory.test-good",
    };

    const updated = addGenesisRecord(addGenesisRecord(ledger, asInput), asOutput);
    expect(updated.records).toHaveLength(2);
    expect(
      updated.records.map((r) => (r.type === "GOOD_ENDOWMENT" ? r.inventoryBucket : undefined)),
    ).toEqual(["INPUT", "OUTPUT"]);
  });

  it("accepts capital endowment records with ProductionUnit owner", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const productionUnitId = allocator.allocate("ProductionUnit", "test-pu");

    const record: GenesisRecord = {
      type: "CAPITAL_ENDOWMENT",
      owner: { type: "PRODUCTION_UNIT", productionUnitId },
      regionId: allocator.allocate("Region", "test-region"),
      goodId: allocator.allocate("Good", "test-capital-good"),
      amount: 50,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts money endowment records with Cohort owner", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const cohortId = allocator.allocate("Cohort", "test-cohort");

    const record: GenesisRecord = {
      type: "MONEY_ENDOWMENT",
      owner: { type: "COHORT", cohortId },
      currencyId: allocator.allocate("Currency", "test-currency"),
      amount: 1000,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts good endowment records with Cohort owner", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const cohortId = allocator.allocate("Cohort", "test-cohort");

    const record: GenesisRecord = {
      type: "GOOD_ENDOWMENT",
      owner: { type: "COHORT", cohortId },
      regionId: allocator.allocate("Region", "test-region"),
      goodId: allocator.allocate("Good", "test-good"),
      amount: 500,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("accepts population endowment records with Cohort owner", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const cohortId = allocator.allocate("Cohort", "test-cohort");

    const record: GenesisRecord = {
      type: "POPULATION_ENDOWMENT",
      owner: { type: "COHORT", cohortId },
      regionId: allocator.allocate("Region", "test-region"),
      amount: 100,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toEqual(record);
  });

  it("maintains immutability: original ledger unchanged after add", () => {
    const ledger = createEmptyWorldGenesisLedger();
    const allocator = createIdAllocator();
    const clanId = allocator.allocate("Clan", "test-clan");

    const record: GenesisRecord = {
      type: "MONEY_ENDOWMENT",
      owner: { type: "CLAN", clanId },
      currencyId: allocator.allocate("Currency", "test-currency"),
      amount: 1000,
      sourceSeedKey: "test-seed",
    };

    const updated = addGenesisRecord(ledger, record);

    expect(ledger.records).toHaveLength(0);
    expect(updated.records).toHaveLength(1);
  });

  it("supports multiple sequential additions", () => {
    const allocator = createIdAllocator();
    let ledger = createEmptyWorldGenesisLedger();

    const record1: GenesisRecord = {
      type: "MONEY_ENDOWMENT",
      owner: { type: "CLAN", clanId: allocator.allocate("Clan", "clan-1") },
      currencyId: allocator.allocate("Currency", "currency-1"),
      amount: 1000,
      sourceSeedKey: "seed-1",
    };

    const record2: GenesisRecord = {
      type: "GOOD_ENDOWMENT",
      owner: { type: "STATE", stateId: allocator.allocate("State", "state-1") },
      regionId: allocator.allocate("Region", "region-1"),
      goodId: allocator.allocate("Good", "good-1"),
      amount: 500,
      sourceSeedKey: "seed-2",
    };

    ledger = addGenesisRecord(ledger, record1);
    ledger = addGenesisRecord(ledger, record2);

    expect(ledger.records).toHaveLength(2);
    expect(ledger.records[0]).toEqual(record1);
    expect(ledger.records[1]).toEqual(record2);
  });
});
