import { describe, expect, it } from "vitest";
import { searchDraftQuery } from "./search-navigation";

describe("search draft deep links", () => {
  it("reads a query with URL-reserved characters from an existing Search form link", () => {
    const query = "Björk & Burial #1? live";
    expect(searchDraftQuery(`#/new?${new URLSearchParams({ query })}`)).toBe(query);
  });

  it("opens a blank Search form for existing links and missing query parameters", () => {
    expect(searchDraftQuery("#/new")).toBe("");
    expect(searchDraftQuery("#/new?other=value")).toBe("");
  });
});
