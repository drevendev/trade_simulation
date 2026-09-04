/**
 * Entry point of the canonical TypeScript engine.
 *
 * This file exists so that the toolchain has something to compile, test and build.
 * It deliberately contains **no canonical economics**: REQ-MIGRATION-003 placed the
 * Config, Domain, Simulation and Diagnostics module areas under `src/`, and the
 * canonical subsystems arrive from M1 onward. Anything economic added here before
 * then would be implementing the specification in the wrong order.
 */

export interface ToolchainStatus {
  readonly runtime: "typescript";
  /** True once REQ-MIGRATION-003 has added the canonical scaffolding. */
  readonly canonicalScaffolding: boolean;
}

export function toolchainStatus(): ToolchainStatus {
  return { runtime: "typescript", canonicalScaffolding: true };
}
