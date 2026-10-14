import { describe, expect, it } from "vitest";
import { sortRows, toggleSort } from "./table-sort";

describe("table sorting", () => {
  it("toggles a date heading from newest to oldest and back", () => {
    const newest = { key: "created" as const, direction: "desc" as const };
    const oldest = toggleSort(newest, "created", "created");
    expect(oldest).toEqual({ key: "created", direction: "asc" });
    expect(toggleSort(oldest, "created", "created")).toEqual(newest);
  });

  it("sorts numeric values and text without mutating the source rows", () => {
    const rows = [{ name: "File 10", size: 40 }, { name: "File 2", size: 5 },
      { name: "File 1", size: 20 }];
    expect(sortRows(rows, row => row.size, "desc").map(row => row.size)).toEqual([40, 20, 5]);
    expect(sortRows(rows, row => row.name, "asc").map(row => row.name))
      .toEqual(["File 1", "File 2", "File 10"]);
    expect(rows[0]?.name).toBe("File 10");
  });
});
