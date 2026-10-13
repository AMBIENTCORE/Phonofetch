import { describe, expect, it } from "vitest";
import { isSkin, SKIN_STORAGE_KEY } from "./skin";

describe("saved app skin", () => {
  it("accepts the original, accent and full dark skins", () => {
    expect(SKIN_STORAGE_KEY).toBe("phonofetch-skin");
    for (const value of ["original", "accents", "liquid"])
      expect(isSkin(value)).toBe(true);
  });

  it("rejects missing or unknown preferences", () => {
    expect(isSkin(null)).toBe(false);
    expect(isSkin("bright")).toBe(false);
  });
});
