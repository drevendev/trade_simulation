/**
 * Typed ledger/flow records tests (REQ-CORE-006).
 *
 * Verifies correct recording and aggregation of MONEY, GOOD and PHYSICAL_LOSS flows.
 */

import { describe, it, expect } from "vitest";
import {
  createEmptyRuntimeLedger,
  addMoneyFlow,
  addGoodFlow,
  addPhysicalLoss,
  createMoneyFlow,
  createGoodFlow,
  createPhysicalLoss,
  type MoneyFlow,
  type GoodFlow,
  type PhysicalLoss,
} from "./ledgerFlow";

describe("REQ-CORE-006: Typed ledger flows", () => {
  describe("LedgerFlow creation", () => {
    it("creates an empty runtime ledger", () => {
      const ledger = createEmptyRuntimeLedger();
      expect(ledger.flows).toHaveLength(0);
    });

    it("creates a money flow", () => {
      const flow = createMoneyFlow(
        0,
        0,
        "USD" as any,
        { type: "STATE", stateId: "s1" as any },
        100,
        "endowment",
      );
      expect(flow.tick).toBe(0);
      expect(flow.phase).toBe(0);
      expect(flow.currencyId).toBe("USD");
      expect(flow.delta).toBe(100);
      expect(flow.reason).toBe("endowment");
    });

    it("creates a good flow", () => {
      const flow = createGoodFlow(
        0,
        1,
        "wheat" as any,
        { type: "CLAN", clanId: "c1" as any },
        "region1" as any,
        50,
        "harvest",
      );
      expect(flow.tick).toBe(0);
      expect(flow.phase).toBe(1);
      expect(flow.goodId).toBe("wheat");
      expect(flow.delta).toBe(50);
      expect(flow.regionId).toBe("region1");
    });

    it("creates a physical loss record", () => {
      const loss = createPhysicalLoss(
        1,
        8,
        "grain" as any,
        "region2" as any,
        5,
        "spoilage",
      );
      expect(loss.tick).toBe(1);
      expect(loss.phase).toBe(8);
      expect(loss.goodId).toBe("grain");
      expect(loss.loss).toBe(5);
      expect(loss.reason).toBe("spoilage");
    });
  });

  describe("Adding flows to ledger", () => {
    it("adds a money flow to ledger", () => {
      let ledger = createEmptyRuntimeLedger();
      const flow = createMoneyFlow(
        0,
        0,
        "USD" as any,
        { type: "STATE", stateId: "s1" as any },
        100,
        "opening",
      );
      ledger = addMoneyFlow(ledger, flow);
      expect(ledger.flows).toHaveLength(1);
      expect(ledger.flows[0]).toBe(flow);
    });

    it("adds multiple flows in order", () => {
      let ledger = createEmptyRuntimeLedger();
      const flow1 = createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 100, "opening");
      const flow2 = createGoodFlow(0, 1, "wheat" as any, { type: "CLAN", clanId: "c1" as any }, "r1" as any, 50, "harvest");
      const loss = createPhysicalLoss(0, 8, "grain" as any, "r1" as any, 5, "spoilage");

      ledger = addMoneyFlow(ledger, flow1);
      ledger = addGoodFlow(ledger, flow2);
      ledger = addPhysicalLoss(ledger, loss);

      expect(ledger.flows).toHaveLength(3);
      expect(ledger.flows[0]).toBe(flow1);
      expect(ledger.flows[1]).toBe(flow2);
      expect(ledger.flows[2]).toBe(loss);
    });

    it("preserves immutability when adding flows", () => {
      const ledger1 = createEmptyRuntimeLedger();
      const flow = createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 100, "opening");
      const ledger2 = addMoneyFlow(ledger1, flow);

      expect(ledger1.flows).toHaveLength(0);
      expect(ledger2.flows).toHaveLength(1);
    });
  });

  describe("Flow attributes", () => {
    it("tracks owner with STATE type", () => {
      const flow = createMoneyFlow(
        0,
        0,
        "USD" as any,
        { type: "STATE", stateId: "state-1" as any },
        100,
        "treasury",
      );
      expect(flow.owner.type).toBe("STATE");
    });

    it("tracks owner with CLAN type", () => {
      const flow = createGoodFlow(
        0,
        1,
        "wheat" as any,
        { type: "CLAN", clanId: "clan-1" as any },
        "r1" as any,
        50,
        "harvest",
      );
      expect(flow.owner.type).toBe("CLAN");
    });

    it("tracks owner with PRODUCTION_UNIT type", () => {
      const flow = createMoneyFlow(
        0,
        5,
        "USD" as any,
        { type: "PRODUCTION_UNIT", productionUnitId: "pu-1" as any },
        200,
        "wage",
      );
      expect(flow.owner.type).toBe("PRODUCTION_UNIT");
    });

    it("includes bucket for good flows", () => {
      const flow = createGoodFlow(
        0,
        3,
        "wheat" as any,
        { type: "CLAN", clanId: "c1" as any },
        "r1" as any,
        100,
        "storage",
        "warehouse",
      );
      expect(flow.bucket).toBe("warehouse");
    });

    it("includes causal linkage", () => {
      const flow = createMoneyFlow(
        0,
        6,
        "USD" as any,
        { type: "STATE", stateId: "s1" as any },
        -50,
        "transfer",
        "r1" as any,
        "trade-tx-1",
      );
      expect(flow.causalLinkage).toBe("trade-tx-1");
    });

    it("allows negative deltas for outflows", () => {
      const moneyOut = createMoneyFlow(
        0,
        2,
        "USD" as any,
        { type: "CLAN", clanId: "c1" as any },
        -75,
        "purchase",
      );
      const goodOut = createGoodFlow(
        0,
        2,
        "wheat" as any,
        { type: "CLAN", clanId: "c1" as any },
        "r1" as any,
        -30,
        "sale",
      );

      expect(moneyOut.delta).toBe(-75);
      expect(goodOut.delta).toBe(-30);
    });

    it("tracks positive loss amounts", () => {
      const loss = createPhysicalLoss(0, 8, "grain" as any, "r1" as any, 10, "spoilage");
      expect(loss.loss).toBe(10);
    });
  });

  describe("Ledger composition", () => {
    it("accumulates flows from multiple phases", () => {
      let ledger = createEmptyRuntimeLedger();

      for (let phase = 0; phase < 5; phase++) {
        const flow = createMoneyFlow(
          0,
          phase,
          "USD" as any,
          { type: "STATE", stateId: "s1" as any },
          10 * (phase + 1),
          `phase-${phase}`,
        );
        ledger = addMoneyFlow(ledger, flow);
      }

      expect(ledger.flows).toHaveLength(5);
      expect((ledger.flows[0] as MoneyFlow).phase).toBe(0);
      expect((ledger.flows[4] as MoneyFlow).phase).toBe(4);
    });

    it("accumulates flows from multiple ticks", () => {
      let ledger = createEmptyRuntimeLedger();

      for (let tick = 0; tick < 3; tick++) {
        const flow = createMoneyFlow(
          tick,
          0,
          "USD" as any,
          { type: "STATE", stateId: "s1" as any },
          100,
          `tick-${tick}`,
        );
        ledger = addMoneyFlow(ledger, flow);
      }

      expect(ledger.flows).toHaveLength(3);
      expect((ledger.flows[0] as MoneyFlow).tick).toBe(0);
      expect((ledger.flows[2] as MoneyFlow).tick).toBe(2);
    });
  });
});
