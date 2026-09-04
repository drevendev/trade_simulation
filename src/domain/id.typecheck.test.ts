import { describe, expect, it } from "vitest";

import { createIdAllocator, type RegionId, type StateId } from "./id";

// These assertions are the actual regression: `npm run typecheck` must fail if any
// `@ts-expect-error` below stops being an error (TypeScript reports an unused
// directive as an error under this repo's strict config), proving distinct ID
// kinds are not interchangeable through ordinary typed API use.
describe("typed ID kind separation (compile-time)", () => {
  it("rejects assigning one ID kind where another, or a bare string, is required", () => {
    const allocator = createIdAllocator();
    const regionId: RegionId = allocator.allocate("Region", "region-alpha");
    const stateId: StateId = allocator.allocate("State", "state-alpha");

    // @ts-expect-error a StateId is not assignable to a RegionId — distinct opaque kinds.
    const mismatched: RegionId = stateId;
    // @ts-expect-error a bare string literal is not assignable to a branded RegionId.
    const fromLiteral: RegionId = "r:1";

    expect(regionId).not.toBe(stateId);
    void mismatched;
    void fromLiteral;
  });

  it("rejects allocating or retiring under a kind that does not match the requested type", () => {
    const allocator = createIdAllocator();

    // @ts-expect-error "State" allocations cannot be assigned to a RegionId binding.
    const wrongKind: RegionId = allocator.allocate("State", "state-alpha");
    void wrongKind;

    const regionId = allocator.allocate("Region", "region-beta");
    expect(() => {
      // @ts-expect-error retiring a RegionId as if it were a StateId must not typecheck.
      allocator.retire("State", regionId);
    }).toThrow(/does not belong to id kind "State"/);
  });
});
