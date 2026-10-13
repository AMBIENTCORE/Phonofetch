import { describe, expect, it } from "vitest";
import { readApiResponse } from "./api-response";

describe("API response parsing", () => {
  it("returns JSON data and preserves API errors", async () => {
    const success = new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json; charset=utf-8" } });
    await expect(readApiResponse<{ ok: boolean }>(success)).resolves.toEqual({ ok: true });
    const denied = new Response(JSON.stringify({ error: "Sign in required" }), {
      status: 401, headers: { "content-type": "application/problem+json" }
    });
    await expect(readApiResponse(denied)).rejects.toThrow("Sign in required");
  });

  it("explains an HTML login or proxy response without showing its contents", async () => {
    const html = "<!DOCTYPE html><html><body>Access sign-in</body></html>";
    for (const status of [200, 502]) {
      const response = new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
      let error: Error | undefined;
      try { await readApiResponse(response); }
      catch (cause) {
        if (!(cause instanceof Error)) throw cause;
        error = cause;
      }
      expect(error?.message).toContain(`HTML (HTTP ${status})`);
      expect(error?.message).toContain("Cloudflare Access");
      expect(error?.message).not.toContain("DOCTYPE");
      expect(error?.message.endsWith(".")).toBe(false);
    }
  });

  it("reports malformed JSON without leaking the response body", async () => {
    const response = new Response("<!DOCTYPE html>", { headers: { "content-type": "application/json" } });
    await expect(readApiResponse(response)).rejects.toThrow("invalid JSON (HTTP 200)");
  });
});
