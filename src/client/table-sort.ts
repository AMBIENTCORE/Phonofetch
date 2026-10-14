export type SortDirection = "asc" | "desc";
export type SortState<Key extends string> = { key: Key; direction: SortDirection };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function toggleSort<Key extends string>(current: SortState<Key>, key: Key, newestFirstKey: Key): SortState<Key> {
  return { key, direction: current.key === key ? current.direction === "asc" ? "desc" : "asc" :
    key === newestFirstKey ? "desc" : "asc" };
}

export function sortRows<Row>(rows: readonly Row[], value: (row: Row) => string | number,
  direction: SortDirection): Row[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    return multiplier * (typeof left === "number" && typeof right === "number" ?
      left - right : collator.compare(String(left), String(right)));
  });
}
