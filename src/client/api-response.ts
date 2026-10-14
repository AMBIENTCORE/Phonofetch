export async function readApiResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
    const format = /\btext\/html\b/i.test(contentType) ? "HTML" : "a non-JSON response";
    const guidance = response.status >= 500 ?
      "A proxy or upstream service failed; retry, then check the tunnel and NAS app logs if it persists" :
      "Reload and sign in to Cloudflare Access again; if this persists, check the tunnel";
    throw new Error(`Phonofetch API returned ${format} (HTTP ${response.status}) instead of JSON. ${guidance}`);
  }
  let data: unknown;
  try { data = await response.json() as unknown; }
  catch (cause) { throw new Error(`Phonofetch API returned invalid JSON (HTTP ${response.status}). Reload and retry`, { cause }); }
  if (!response.ok)
    throw new Error(typeof data === "object" && data !== null && "error" in data ?
      String(data.error) : `HTTP ${response.status}`);
  return data as T;
}
