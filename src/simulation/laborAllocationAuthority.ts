/**
 * Compatibility seam for Phase-5 wage persistence. Authority issuance and verification
 * live beside the canonical Phase-3 handler so the private provenance registry cannot
 * be populated by callers of the persistence boundary.
 */
export { requireCompletePhase3LaborAllocationAuthority } from "./laborAllocation";
