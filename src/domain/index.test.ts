import { describe, expect, it } from "vitest";

import { DOMAIN_MODULE_AREA } from "./index";

describe("domain module area", () => {
  it("exists as a distinct scaffolding area and typechecks under vitest", () => {
    expect(DOMAIN_MODULE_AREA).toBe("domain");
  });
});
