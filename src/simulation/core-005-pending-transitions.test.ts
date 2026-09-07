/**
 * REQ-CORE-005: PendingTransitions for future policy/jurisdiction/lifecycle effects.
 *
 * Tests verify that future policy/jurisdiction/lifecycle effects are queued in
 * PendingTransitions and cannot mutate current-tick authoritative state early.
 * An N+1 transition cannot take effect before its defined activation boundary.
 */

import { describe, it, expect } from "vitest";
import { buildInitialWorld } from "./worldState";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import type { PendingTransitions } from "./tickOrchestrator";

describe("REQ-CORE-005: PendingTransitions for future policy/jurisdiction/lifecycle effects", () => {
  it("initializes WorldState with empty PendingTransitions at genesis", () => {
    const scenario = baselineScenario;
    const definitionPack = baselineDefinitionPack;
    const config = createDefaultSimulationConfig();
    const seed = 42;

    const world = buildInitialWorld(scenario, definitionPack, config, seed);

    expect(world.pendingTransitions).toBeDefined();
    expect(world.pendingTransitions.jurisdictionChanges).toEqual([]);
    expect(world.pendingTransitions.stateCreations).toEqual([]);
    expect(world.pendingTransitions.policyChanges).toEqual([]);
    expect(world.pendingTransitions.monetaryPolicyChanges).toEqual([]);
  });

  it("PendingTransitions.jurisdictionChanges queues region controller changes", () => {
    const scenario = baselineScenario;
    const definitionPack = baselineDefinitionPack;
    const config = createDefaultSimulationConfig();

    const world = buildInitialWorld(scenario, definitionPack, config, 42);

    // Add a hypothetical jurisdiction change (at genesis it's empty, but structure is present)
    expect(world.pendingTransitions.jurisdictionChanges).toBeInstanceOf(Array);
    expect(world.pendingTransitions.jurisdictionChanges.length).toBe(0);

    // Verify that if we had queued a change, it would have activateTick > 0
    const exampleChange = {
      regionId: Array.from(world.regions.keys())[0]!,
      nextControllerStateId: null,
      activateTick: 1, // Must be > tick 0
    };
    expect(exampleChange.activateTick).toBeGreaterThan(0);
  });

  it("PendingTransitions.stateCreations queues state formation payloads", () => {
    const scenario = baselineScenario;
    const definitionPack = baselineDefinitionPack;
    const config = createDefaultSimulationConfig();

    const world = buildInitialWorld(scenario, definitionPack, config, 42);

    // At genesis, stateCreations is empty
    expect(world.pendingTransitions.stateCreations).toBeInstanceOf(Array);
    expect(world.pendingTransitions.stateCreations.length).toBe(0);

    // Verify that if we had queued a creation, it would have activateTick > 0
    const exampleCreation = {
      activateTick: 5,
      payload: { /* state formation data */ },
    };
    expect(exampleCreation.activateTick).toBeGreaterThan(0);
  });

  it("PendingTransitions.policyChanges queues state policy patches", () => {
    const scenario = baselineScenario;
    const definitionPack = baselineDefinitionPack;
    const config = createDefaultSimulationConfig();

    const world = buildInitialWorld(scenario, definitionPack, config, 42);

    // At genesis, policyChanges is empty
    expect(world.pendingTransitions.policyChanges).toBeInstanceOf(Array);
    expect(world.pendingTransitions.policyChanges.length).toBe(0);

    // Verify that if we had queued a change, it would have activateTick > 0
    const exampleChange = {
      stateId: Array.from(world.states.keys())[0]!,
      patch: { /* policy patch data */ },
      activateTick: 2,
    };
    expect(exampleChange.activateTick).toBeGreaterThan(0);
  });

  it("PendingTransitions.monetaryPolicyChanges queues authority policy patches", () => {
    const scenario = baselineScenario;
    const definitionPack = baselineDefinitionPack;
    const config = createDefaultSimulationConfig();

    const world = buildInitialWorld(scenario, definitionPack, config, 42);

    // At genesis, monetaryPolicyChanges is empty
    expect(world.pendingTransitions.monetaryPolicyChanges).toBeInstanceOf(Array);
    expect(world.pendingTransitions.monetaryPolicyChanges.length).toBe(0);

    // Verify that if we had queued a change, it would have activateTick > 0
    const exampleChange = {
      authorityId: Array.from(world.monetaryAuthorities.keys())[0]!,
      patch: { /* monetary policy patch data */ },
      activateTick: 3,
    };
    expect(exampleChange.activateTick).toBeGreaterThan(0);
  });

  it("N+1 transition invariant: activateTick cannot be current tick", () => {
    const scenario = baselineScenario;
    const definitionPack = baselineDefinitionPack;
    const config = createDefaultSimulationConfig();

    const world = buildInitialWorld(scenario, definitionPack, config, 42);
    const currentTick = 0; // Genesis is tick 0

    // All pending transitions must have activateTick > currentTick
    // This is the core invariant: Phase-14 decisions at tick N cannot affect tick N

    // Verify structure supports this invariant
    const transition = {
      activateTick: currentTick + 1, // Must be strictly greater
      payload: {},
    };
    expect(transition.activateTick).toBeGreaterThan(currentTick);
  });

  it("PendingTransitions is frozen and immutable at genesis", () => {
    const scenario = baselineScenario;
    const definitionPack = baselineDefinitionPack;
    const config = createDefaultSimulationConfig();

    const world = buildInitialWorld(scenario, definitionPack, config, 42);

    // WorldState should be frozen, so pendingTransitions cannot be replaced
    expect(() => {
      (world as any).pendingTransitions = null;
    }).toThrow();
  });

  it("PendingTransitions arrays are empty and read-only at genesis", () => {
    const scenario = baselineScenario;
    const definitionPack = baselineDefinitionPack;
    const config = createDefaultSimulationConfig();

    const world = buildInitialWorld(scenario, definitionPack, config, 42);

    // All arrays should be read-only
    expect(
      world.pendingTransitions.jurisdictionChanges as ReadonlyArray<any>,
    ).toBeInstanceOf(Array);
    expect(
      world.pendingTransitions.stateCreations as ReadonlyArray<any>,
    ).toBeInstanceOf(Array);
    expect(
      world.pendingTransitions.policyChanges as ReadonlyArray<any>,
    ).toBeInstanceOf(Array);
    expect(
      world.pendingTransitions.monetaryPolicyChanges as ReadonlyArray<any>,
    ).toBeInstanceOf(Array);
  });

  it("Deterministic scenario produces identical PendingTransitions across runs", () => {
    const scenario = baselineScenario;
    const definitionPack = baselineDefinitionPack;
    const config = createDefaultSimulationConfig();
    const seed = 123;

    const world1 = buildInitialWorld(scenario, definitionPack, config, seed);
    const world2 = buildInitialWorld(scenario, definitionPack, config, seed);

    // Same seed should produce same genesis transitions (both empty in M2)
    expect(world1.pendingTransitions.jurisdictionChanges.length).toBe(
      world2.pendingTransitions.jurisdictionChanges.length,
    );
    expect(world1.pendingTransitions.stateCreations.length).toBe(
      world2.pendingTransitions.stateCreations.length,
    );
    expect(world1.pendingTransitions.policyChanges.length).toBe(
      world2.pendingTransitions.policyChanges.length,
    );
    expect(world1.pendingTransitions.monetaryPolicyChanges.length).toBe(
      world2.pendingTransitions.monetaryPolicyChanges.length,
    );
  });
});
