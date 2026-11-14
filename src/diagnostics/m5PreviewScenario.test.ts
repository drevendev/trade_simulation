/** #677: real 16-phase M5 preview generation, determinism and fail-closed checks. */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createM5PreviewScenario, generateM5Preview, serializeM5Preview,
  generateM5ArrivalPreview, serializeM5ArrivalPreview, M5_PREVIEW_TICK,
} from "./m5PreviewScenario";
import { executeM5AutonomousRegionalTradeTick } from "../simulation/m5AutonomousRegionalTradeTick";
import { projectM5TradeTick } from "./m5TradePreview";
import { buildInitialWorld } from "../simulation/worldState";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { PhaseHandler } from "../simulation/tickOrchestrator";

function canonical(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value].map(([k, v]) => [String(k), canonical(v)] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  }
  if (value instanceof Set) return [...value].map(canonical).sort();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, canonical(val)]));
  }
  return value;
}

const upstream: PhaseHandler = (world, context) =>
  context.phase === 1 ? {
    ...context,
    effectiveJurisdictionByRegion: new Map([...world.regions].map(
      ([id, region]) => [id, region.controllerStateId] as const,
    )),
  } : context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;

describe("M5 #677 source-backed Pages generator", () => {
  it("projects paid cross-currency dispatch, real fees, FX reserves and Phase-15 rate movement", () => {
    const preview = generateM5Preview(createM5PreviewScenario());
    expect(preview.milestone).toBe("M5");
    expect(preview.tick).toBe(M5_PREVIEW_TICK);
    const routes = preview.routes.filter(route => route.departures.length > 0);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.status).toBe("PAID_DISPATCH");
    expect(routes[0]!.capacityWeightUnits).toBeGreaterThan(0);
    expect(routes[0]!.dispatchedWeightUnits).toBeGreaterThan(0);
    expect(routes[0]!.dispatchedWeightUnits).toBeLessThanOrEqual(routes[0]!.capacityWeightUnits);
    const cargo = routes[0]!.departures[0]!;
    expect(cargo.quantity).toBeGreaterThan(0);
    expect(cargo.fxSettlementId).not.toBeNull();
    expect(cargo.invoiceCurrency).not.toBe(cargo.buyerCurrency);
    expect(cargo.buyerGoodsPaymentAmount).toBeGreaterThan(0);
    expect(cargo.tariffAmount).toBeGreaterThan(0);
    expect(cargo.transportFeeAmount).toBeGreaterThan(0);
    expect(preview.fxPools.some(pool =>
      pool.baseReserve > 0 && pool.quoteReserve > 0 &&
      pool.spotBefore > 0 && pool.spotAfter > 0 &&
      pool.spotBefore !== pool.spotAfter)).toBe(true);
  });

  it("exposes source-backed tick-8 arrival, never a scheduled forecast", () => {
    const scenario = createM5PreviewScenario();
    const before = JSON.stringify(canonical(scenario.opening));
    const dispatch = generateM5Preview(scenario);
    const arrived = generateM5ArrivalPreview(scenario);
    const due = dispatch.routes.flatMap(route => route.departures)
      .filter(shipment => shipment.arrivalTick === M5_PREVIEW_TICK + 1);
    const receipts = arrived.routes.flatMap(route => route.arrivals);
    expect(due).toHaveLength(1);
    expect(arrived.tick).toBe(M5_PREVIEW_TICK + 1);
    expect(receipts).toEqual(due);
    expect(JSON.stringify(canonical(scenario.opening))).toBe(before);
    const exact = serializeM5ArrivalPreview(scenario);
    expect(exact).toBe(serializeM5ArrivalPreview(createM5PreviewScenario()));
    expect(JSON.parse(exact)).toEqual(arrived);
  });

  it("exposes the actual delivery through CLI without changing the published tick-7 receipt", () => {
    const cli = fileURLToPath(new URL("./generateM5Preview.mjs", import.meta.url));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const delivery = execFileSync(process.execPath, [cli, "--arrival-stdout"], {
      cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    expect(delivery).toBe(serializeM5ArrivalPreview(createM5PreviewScenario()));
    expect(JSON.parse(delivery).routes.flatMap(
      (route: { arrivals: readonly unknown[] }) => route.arrivals,
    )).toHaveLength(1);
    const published = readFileSync(
      fileURLToPath(new URL("../../docs/m5-preview.json", import.meta.url)), "utf8",
    );
    expect(published).toBe(serializeM5Preview(createM5PreviewScenario()));
  }, 90_000);

  it("refuses a delivery preview if the source tick never paid for cargo", () => {
    const scenario = createM5PreviewScenario();
    const denied = {
      ...scenario,
      options: { ...scenario.options, phase1TradeLawProvider: () => undefined },
    };
    expect(() => generateM5ArrivalPreview(denied)).toThrow(
      /no paid cargo due at next tick/,
    );
  });

  it("proves the tick-7 paid shipment arrives exactly once at tick 8", () => {
    const scenario = createM5PreviewScenario();
    const first = executeM5AutonomousRegionalTradeTick(
      scenario.opening, M5_PREVIEW_TICK, upstream,
      (_phase, world) => world, scenario.options,
    );
    const cargo = [...(first.world.shipments?.values() ?? [])].find(shipment =>
      shipment.departureTick === M5_PREVIEW_TICK &&
      shipment.arrivalTick === M5_PREVIEW_TICK + 1,
    );
    expect(cargo).toBeDefined();
    expect(first.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY" &&
      tx.transactionId === "tx:delivery:" + cargo!.id)).toHaveLength(0);

    // The next canonical 16-phase tick, not a forecast or projected receipt,
    // must settle the same paid cargo into its destination exactly once.
    const nextTick = M5_PREVIEW_TICK + 1;
    const second = executeM5AutonomousRegionalTradeTick(
      first.world, nextTick, upstream,
      (_phase, world) => world, scenario.options,
    );
    const receipt = projectM5TradeTick(
      first.world, second, nextTick, scenario.options.infrastructureFactors,
    );
    const arrivals = receipt.routes.flatMap(route => route.arrivals)
      .filter(arrival => arrival.id === cargo!.id);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({
      id: cargo!.id,
      quantity: cargo!.quantity,
      arrivalTick: nextTick,
      fxSettlementId: cargo!.fxSettlementId ?? null,
    });
    expect(second.world.shipments?.has(cargo!.id)).toBe(false);
    expect(second.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY" &&
      tx.transactionId === "tx:delivery:" + cargo!.id)).toHaveLength(1);

    // A missing economic delivery receipt cannot be turned into a plausible
    // Pages arrival by a physical-stock-only projection.
    const withoutDelivery = {
      ...second,
      context: {
        ...second.context,
        transactions: second.context.transactions.filter(tx =>
          tx.transactionId !== "tx:delivery:" + cargo!.id),
      },
    };
    expect(() => projectM5TradeTick(
      first.world, withoutDelivery, nextTick, scenario.options.infrastructureFactors,
    )).toThrow(/unmatched or duplicate shipment delivery/);
  });

  it("serializes source-backed data byte-for-byte deterministically", () => {
    const first = serializeM5Preview(createM5PreviewScenario());
    const second = serializeM5Preview(createM5PreviewScenario());
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(JSON.parse(first)).toEqual(generateM5Preview(createM5PreviewScenario()));
  });

  it("pins the checked-in Pages artifact to exact canonical execution bytes", () => {
    const published = readFileSync(
      fileURLToPath(new URL("../../docs/m5-preview.json", import.meta.url)), "utf8",
    );
    expect(published).toBe(serializeM5Preview(createM5PreviewScenario()));
    const parsed = JSON.parse(published);
    expect(parsed.routes.some((route: { departures: readonly unknown[] }) =>
      route.departures.length > 0)).toBe(true);
  });

  it("exports the exact canonical JSON through the production CLI without writing a placeholder", () => {
    const cli = fileURLToPath(new URL("./generateM5Preview.mjs", import.meta.url));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const output = execFileSync(process.execPath, [cli, "--stdout"], {
      cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    expect(output).toBe(serializeM5Preview(createM5PreviewScenario()));
    expect(JSON.parse(output).routes.some((route: { departures: readonly unknown[] }) =>
      route.departures.length > 0)).toBe(true);
  }, 90_000);

  it("fails closed on a missing or stale staged receipt, then accepts only canonical bytes", () => {
    const cli = fileURLToPath(new URL("./generateM5Preview.mjs", import.meta.url));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), "m5-preview-receipt-"));
    const candidate = join(directory, "candidate.json");
    const check = () => {
      const processResult = spawnSync(process.execPath, [cli, "--check", candidate], {
        cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      expect(processResult.error).toBeUndefined();
      return processResult;
    };
    try {
      const missing = check();
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("candidate M5 receipt is missing");
      // --check must never create either candidate or canonical artifact.
      writeFileSync(candidate, '{"milestone":"M5","tick":7}\n', "utf8");
      const stale = check();
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toContain("candidate M5 receipt differs from canonical tick output");
      writeFileSync(candidate, serializeM5Preview(createM5PreviewScenario()), "utf8");
      const exact = check();
      expect(exact.status).toBe(0);
      expect(exact.stderr).toBe("");
      expect(exact.stdout).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 240_000);

  it("checks a staged real tick-8 delivery receipt without editing tick-7 data", () => {
    const cli = fileURLToPath(new URL("./generateM5Preview.mjs", import.meta.url));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const dispatchPath = fileURLToPath(new URL("../../docs/m5-preview.json", import.meta.url));
    const dispatchBefore = readFileSync(dispatchPath, "utf8");
    const directory = mkdtempSync(join(tmpdir(), "m5-arrival-receipt-"));
    const candidate = join(directory, "candidate.json");
    const check = () => {
      const result = spawnSync(process.execPath, [cli, "--arrival-check", candidate], {
        cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      return result;
    };
    try {
      const missing = check();
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("candidate M5 arrival receipt is missing");
      writeFileSync(candidate, serializeM5Preview(createM5PreviewScenario()), "utf8");
      const stale = check();
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toContain("candidate M5 arrival receipt differs");
      const valid = serializeM5ArrivalPreview(createM5PreviewScenario());
      writeFileSync(candidate, valid, "utf8");
      const exact = check();
      expect(exact.status).toBe(0);
      expect(exact.stderr).toBe("");
      expect(exact.stdout).toBe("");
      writeFileSync(candidate, valid.replace('"tick": 8', '"tick": 9'), "utf8");
      expect(check().status).not.toBe(0);
    } finally {
      expect(readFileSync(dispatchPath, "utf8")).toBe(dispatchBefore);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 240_000);

  it("pins the published tick-8 arrival sidecar to real second-tick execution bytes", () => {
    const published = readFileSync(
      fileURLToPath(new URL("../../docs/m5-arrival.json", import.meta.url)), "utf8",
    );
    const canonical = serializeM5ArrivalPreview(createM5PreviewScenario());
    expect(published).toBe(canonical);
    const parsed = JSON.parse(published);
    expect(parsed.milestone).toBe("M5");
    expect(parsed.tick).toBe(M5_PREVIEW_TICK + 1);
    const receipts = parsed.routes.flatMap((route: { arrivals: readonly unknown[] }) => route.arrivals);
    expect(receipts).toHaveLength(1);
    expect(readFileSync(
      fileURLToPath(new URL("../../docs/m5-preview.json", import.meta.url)), "utf8",
    )).toBe(serializeM5Preview(createM5PreviewScenario()));
  });

  it("does not mutate the opening world or consume an extra economic replay", () => {
    const scenario = createM5PreviewScenario();
    const before = JSON.stringify(canonical(scenario.opening));
    const control = executeM5AutonomousRegionalTradeTick(
      scenario.opening, M5_PREVIEW_TICK, upstream,
      (_phase, world) => world, scenario.options,
    );
    const projected = generateM5Preview(scenario);
    const after = executeM5AutonomousRegionalTradeTick(
      scenario.opening, M5_PREVIEW_TICK, upstream,
      (_phase, world) => world, scenario.options,
    );
    expect(projected.routes[0]?.departures.length).toBeGreaterThan(0);
    expect(JSON.stringify(canonical(scenario.opening))).toBe(before);
    expect(canonical(after.world)).toEqual(canonical(control.world));
    expect(canonical(after.context.transactions)).toEqual(canonical(control.context.transactions));
  });

  it("pins Alpha's explicit issuer and refuses a second real reciprocal FX pool", () => {
    const scenario = createM5PreviewScenario();
    const sourceIssuer = [...scenario.opening.monetaryAuthorities.values()].find(
      authority => authority.seed.key === "authority:alpha",
    );
    expect(sourceIssuer?.fxPools.has("fxpool:currency:alpha-currency:beta")).toBe(true);
    expect([...scenario.opening.monetaryAuthorities.values()].reduce(
      (sum, authority) => sum + authority.fxPools.size, 0,
    )).toBe(1);

    // Restore the actual reciprocal Beta-issuer pool from unfiltered baseline
    // stock, rather than fabricating an arbitrary conflicting pool.
    const fullBaseline = buildInitialWorld(
      baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
    );
    const baselineBeta = [...fullBaseline.monetaryAuthorities.values()].find(
      authority => authority.seed.key === "authority:beta",
    );
    const reciprocal = baselineBeta?.fxPools.get("fxpool:currency:beta-currency:alpha");
    const betaEntry = [...scenario.opening.monetaryAuthorities].find(
      ([, authority]) => authority.seed.key === "authority:beta",
    );
    if (!reciprocal || !betaEntry) throw new Error("Expected baseline reciprocal Beta FX pool");
    const [betaId, beta] = betaEntry;
    const authorities = new Map(scenario.opening.monetaryAuthorities);
    authorities.set(betaId, {
      ...beta,
      fxPools: new Map(beta.fxPools).set(reciprocal.pairId, reciprocal),
    });
    const ambiguous = {
      ...scenario,
      opening: { ...scenario.opening, monetaryAuthorities: authorities },
    };
    expect(() => generateM5Preview(ambiguous)).toThrow(
      /exactly one explicit issuer FX pool; missing or ambiguous pair/,
    );
    expect(scenario.opening.monetaryAuthorities.get(betaId)?.fxPools.size).toBe(0);
  });

  it("refuses to publish an unauthorized route instead of inventing a trade", () => {
    const scenario = createM5PreviewScenario();
    const denied = {
      ...scenario,
      options: { ...scenario.options, phase1TradeLawProvider: () => undefined },
    };
    expect(() => generateM5Preview(denied)).toThrow(
      /fixture lacks paid FX cargo/,
    );
    expect(scenario.opening.shipments?.size ?? 0).toBe(0);
  });

  it("fails closed if actual infrastructure factors are not provided", () => {
    const scenario = createM5PreviewScenario();
    expect(() => generateM5Preview({
      ...scenario,
      options: { ...scenario.options, infrastructureFactors: new Map() },
    })).toThrow();
    expect(scenario.opening.shipments?.size ?? 0).toBe(0);
  });
});
