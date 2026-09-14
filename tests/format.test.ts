import { describe, it, expect } from "vitest";
import { formatElapsed, formatPrice } from "../src/shared/format.js";

describe("formatElapsed", () => {
  it("formats zero as 00:00:00", () => {
    expect(formatElapsed(0)).toBe("00:00:00");
  });

  it("formats the status strip example, 42 min 13 s", () => {
    expect(formatElapsed((42 * 60 + 13) * 1000)).toBe("00:42:13");
  });

  it("formats over an hour", () => {
    expect(formatElapsed((90 * 60) * 1000)).toBe("01:30:00");
  });

  it("clamps negative durations to zero", () => {
    expect(formatElapsed(-500)).toBe("00:00:00");
  });
});

describe("formatPrice", () => {
  it("prefixes a dollar sign when missing", () => {
    expect(formatPrice("12")).toBe("$12");
  });

  it("leaves an existing dollar sign alone", () => {
    expect(formatPrice("$12.50")).toBe("$12.50");
  });

  it("passes through empty as empty", () => {
    expect(formatPrice("  ")).toBe("");
  });
});
