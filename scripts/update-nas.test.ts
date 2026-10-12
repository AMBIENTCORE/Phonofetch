import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function shellPath(path: string): string {
  return process.platform === "win32" ? path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replace(/\\/g, "/") : path;
}

function harness() {
  const folder = mkdtempSync(join(tmpdir(), "phonofetch-updater-"));
  folders.push(folder);
  const deploy = join(folder, "deployment", "Phonofetch");
  const data = join(folder, "storage", "phonofetch");
  const bin = join(folder, "bin");
  mkdirSync(deploy, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(deploy, "compose.yaml"), "services:\n  phonofetch:\n    image: phonofetch:local\n");
  writeFileSync(join(deploy, ".env"), "SLSKD_API_KEY=test-placeholder-only\n");
  writeFileSync(join(data, "phonofetch.sqlite"), "existing-database");
  const log = join(folder, "operations.log");
  const deployed = join(folder, "deployed");
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "$PHONOFETCH_TEST_LOG"
case "$1" in
  inspect)
    case "$*" in
      *com.docker.compose.project.working_dir*) printf '%s\\n' "$PHONOFETCH_DEPLOY_DIR" ;;
      *com.docker.compose.project.config_files*) printf '%s/compose.yaml\\n' "$PHONOFETCH_DEPLOY_DIR" ;;
      *com.docker.compose.project*) printf 'phonofetch\\n' ;;
      *'.Destination "/data"'*) printf '%s\\n' "$PHONOFETCH_DATA_DIR" ;;
      *'.Image'*) if [ -e "$PHONOFETCH_TEST_DEPLOYED" ]; then echo sha256:new; else echo sha256:old; fi ;;
      *'.State.Health'*) echo healthy ;;
      *) exit 2 ;;
    esac ;;
  compose)
    case "$*" in
      *'config --services'*) printf '%s\\n' "\${PHONOFETCH_TEST_SERVICES:-phonofetch}" ;;
      *'config --images'*) echo phonofetch:local ;;
      *'up -d --no-deps --force-recreate phonofetch'*) touch "$PHONOFETCH_TEST_DEPLOYED" ;;
      *) exit 2 ;;
    esac ;;
  image) if [ "\${PHONOFETCH_TEST_SAME_IMAGE:-}" = 1 ]; then echo sha256:old; else echo sha256:new; fi ;;
  build) [ "\${PHONOFETCH_TEST_BUILD_FAIL:-}" != 1 ] ;;
  tag|stop|start) exit 0 ;;
  *) exit 2 ;;
esac
`);
  const curl = join(bin, "curl");
  writeFileSync(curl, `#!/bin/sh
case "$*" in
  *'main.tar.gz'*)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then shift; printf 'fixture archive' > "$1"; exit 0; fi
      shift
    done
    exit 2 ;;
  *'127.0.0.1:7289/api/health'*) [ "\${PHONOFETCH_TEST_HEALTH_FAIL:-}" != 1 ] ;;
  *) exit 2 ;;
esac
`);
  const tar = join(bin, "tar");
  writeFileSync(tar, `#!/bin/sh
case "$1" in
  -tzf) exit 0 ;;
  -xzf)
    shift
    shift
    [ "$1" = -C ] || exit 2
    mkdir -p "$2"
    touch "$2/Dockerfile" "$2/package-lock.json" ;;
  *) exit 2 ;;
esac
`);
  const cp = join(bin, "cp");
  writeFileSync(cp, `#!/bin/sh
if [ "\${PHONOFETCH_TEST_BACKUP_FAIL:-}" = 1 ]; then exit 3; fi
/usr/bin/cp "$@"
`);
  for (const script of [docker, curl, tar, cp]) chmodSync(script, 0o755);

  const script = resolve("scripts", "update-nas.sh");
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/sh";
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")),
    PHONOFETCH_TEST_PATH: `${shellPath(bin)}:/usr/bin:/bin`,
    PHONOFETCH_DEPLOY_DIR: shellPath(deploy),
    PHONOFETCH_DATA_DIR: shellPath(data),
    PHONOFETCH_TEST_LOG: shellPath(log),
    PHONOFETCH_TEST_DEPLOYED: shellPath(deployed)
  };
  const run = (mode?: string, extraEnv: Record<string, string> = {}) =>
    spawnSync(shell, ["-c", 'PATH="$PHONOFETCH_TEST_PATH"; export PATH; exec /bin/sh "$@"',
      "updater-test", shellPath(script), ...(mode ? [mode] : [])], {
      env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 20000
    });
  return { run, folder, deploy, log, deployed };
}

describe("NAS updater", () => {
  it("checks the existing stack without downloading, stopping or printing credentials", () => {
    const { run, log } = harness();
    const result = run("--check");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("existing phonofetch Compose project");
    expect(result.stdout).not.toContain("test-placeholder-only");
    const operations = readFileSync(log, "utf8");
    expect(operations).toContain("config --services");
    expect(operations).not.toMatch(/\b(build|tag|stop|up -d)\b/);
  });

  it("builds, backs up and replaces only phonofetch, then verifies health", () => {
    const { run, deploy, deployed, log } = harness();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Update successful");
    expect(existsSync(deployed)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("up -d --no-deps --force-recreate phonofetch");
    expect(readFileSync(log, "utf8")).not.toContain("slskd");
    const backups = readdirSync(deploy).filter(name => name.startsWith("phonofetch-data-backup-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(deploy, backups[0]!, "phonofetch.sqlite"), "utf8")).toBe("existing-database");
  });

  it("does not stop or deploy when the build fails", () => {
    const { run, log, deployed } = harness();
    const result = run(undefined, { PHONOFETCH_TEST_BUILD_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Image build failed");
    expect(existsSync(deployed)).toBe(false);
    expect(readFileSync(log, "utf8")).not.toMatch(/\bstop phonofetch\b|\bup -d\b/);
  });

  it("restarts the existing container and skips deployment if backup fails", () => {
    const { run, log, deployed } = harness();
    const result = run(undefined, { PHONOFETCH_TEST_BACKUP_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing container restarted");
    expect(existsSync(deployed)).toBe(false);
    const operations = readFileSync(log, "utf8");
    expect(operations).toContain("stop phonofetch");
    expect(operations).toContain("start phonofetch");
    expect(operations).not.toContain("up -d --no-deps");
  });

  it("refuses to touch a Compose project containing other services", () => {
    const { run, log } = harness();
    const result = run(undefined, { PHONOFETCH_TEST_SERVICES: "phonofetch\nslskd" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to update a stack with other services");
    expect(readFileSync(log, "utf8")).not.toMatch(/\b(build|stop|up -d)\b/);
  });

  it("does not interrupt the container when the built image is unchanged", () => {
    const { run, log, deployed } = harness();
    const result = run(undefined, { PHONOFETCH_TEST_SAME_IMAGE: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no redeployment needed");
    expect(existsSync(deployed)).toBe(false);
    expect(readFileSync(log, "utf8")).not.toMatch(/\bstop phonofetch\b|\bup -d\b/);
  });

  it("reports a failed health check without an unsafe image-only rollback", () => {
    const { run, deploy, log } = harness();
    const result = run(undefined, { PHONOFETCH_TEST_HEALTH_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("host port 7289 is unavailable");
    expect(readdirSync(deploy).some(name => name.startsWith("phonofetch-data-backup-"))).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("up -d --no-deps --force-recreate phonofetch");
    expect(readFileSync(log, "utf8")).not.toContain("tag sha256:old phonofetch:local");
  });
});
