import { describe, expect, it } from "vitest";
import { searchDraftHash, searchDraftQuery } from "./search-navigation";

describe("dashboard search navigation", () => {
  it("carries a query with URL-reserved characters to the Search form", () => {
    const query = "Björk & Burial #1? live";
    expect(searchDraftQuery(searchDraftHash(query))).toBe(query);
    expect(searchDraftHash(query).startsWith("#/new?query=")).toBe(true);
  });

  it("opens a blank Search form for existing links and missing query parameters", () => {
    expect(searchDraftQuery("#/new")).toBe("");
    expect(searchDraftQuery("#/new?other=value")).toBe("");
  });
});
