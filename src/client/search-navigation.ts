export function searchDraftHash(query: string): string {
  return `#/new?${new URLSearchParams({ query }).toString()}`;
}

export function searchDraftQuery(hash: string): string {
  return hash.startsWith("#/new?") ? new URLSearchParams(hash.slice("#/new?".length)).get("query") ?? "" : "";
}
