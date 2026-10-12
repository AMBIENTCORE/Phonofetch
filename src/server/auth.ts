import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { Config } from "./config";
import { Store } from "./db";

const ttl = 7 * 24 * 60 * 60 * 1000;
const attempts = new Map<string, { count: number; until: number }>();

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function cookie(req: Request): string | undefined {
  return req.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("pf_session="))?.slice("pf_session=".length);
}

function sessionHash(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

function session(req: Request, store: Store, secret: string): { csrf_token: string } | undefined {
  const token = cookie(req);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  return store.get<{ csrf_token: string }>("SELECT csrf_token FROM sessions WHERE token_hash=? AND expires_at>?",
    sessionHash(token, secret), new Date().toISOString());
}

function setCookie(req: Request, res: Response, value: string, maxAge: number): void {
  res.setHeader("Set-Cookie", `pf_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? "; Secure" : ""}`);
}

function checkOrigin(req: Request): void {
  const origin = req.headers.origin;
  if (!origin || origin !== `${req.protocol}://${req.get("host")}`) throw new ApiError(403, "Invalid request origin");
}

export function installAuth(app: Express, store: Store, config: Config): void {
  const passwordSalt = Buffer.from(config.PHONOFETCH_SESSION_SECRET);
  const expected = scryptSync(config.PHONOFETCH_AUTH_PASSWORD, passwordSalt, 64);

  app.get("/api/session", (req, res) => {
    const current = session(req, store, config.PHONOFETCH_SESSION_SECRET);
    res.json(current ? { authenticated: true, csrf: current.csrf_token } : { authenticated: false });
  });

  app.post("/api/login", (req, res) => {
    checkOrigin(req);
    if (!req.is("application/json")) throw new ApiError(415, "JSON required");
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const record = attempts.get(key);
    if (record && record.until > now && record.count >= 5) throw new ApiError(429, "Too many login attempts; try later");
    const actual = scryptSync(body.password.slice(0, 4096), passwordSalt, 64);
    const valid = timingSafeEqual(expected, actual) && body.username === config.PHONOFETCH_AUTH_USERNAME;
    if (!valid) {
      if (attempts.size >= 5000) {
        for (const [ip, attempt] of attempts) if (attempt.until <= now) attempts.delete(ip);
        if (attempts.size >= 5000 && !attempts.has(key)) throw new ApiError(429, "Too many login attempts; try later");
      }
      const count = record && record.until > now ? record.count + 1 : 1;
      attempts.set(key, { count, until: now + 15 * 60 * 1000 });
      store.event("warning", "auth", "login_failed", "Invalid login attempt");
      throw new ApiError(401, "Invalid credentials");
    }
    attempts.delete(key);
    store.run("DELETE FROM sessions WHERE expires_at<=?", new Date(now).toISOString());
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    store.run("INSERT INTO sessions(token_hash,csrf_token,expires_at) VALUES(?,?,?)",
      sessionHash(token, config.PHONOFETCH_SESSION_SECRET), csrf, new Date(now + ttl).toISOString());
    setCookie(req, res, token, ttl / 1000);
    store.event("info", "auth", "login", "Signed in");
    res.json({ authenticated: true, csrf });
  });

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/health") { next(); return; }
    const current = session(req, store, config.PHONOFETCH_SESSION_SECRET);
    if (!current) { res.status(401).json({ error: "Sign in required" }); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      try {
        checkOrigin(req);
        const csrf = req.get("X-CSRF-Token") ?? "";
        const a = Buffer.from(csrf);
        const b = Buffer.from(current.csrf_token);
        if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(403, "Invalid CSRF token");
      } catch (error) { next(error); return; }
    }
    next();
  });

  app.post("/api/logout", (req, res) => {
    const token = cookie(req);
    if (token) store.run("DELETE FROM sessions WHERE token_hash=?", sessionHash(token, config.PHONOFETCH_SESSION_SECRET));
    setCookie(req, res, "", 0);
    res.json({ ok: true });
  });
}
