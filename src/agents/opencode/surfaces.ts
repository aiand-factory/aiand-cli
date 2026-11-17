import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveWindowsCommand } from "../../cli/win-spawn.js";
import { agentHome } from "../../config.js";
import { detectBinary } from "../detect.js";

/**
 * The two OpenCode programs that read one opencode.json, and the background
 * service between them in OpenCode 2.x. Checked against OpenCode Desktop
 * 2.3.0 (macOS) and its bundled CLI, the npm `@opencode/cli` 2.0.28 and
 * 2.3.0, and the npm `opencode-ai` 1.18.32:
 *
 * - `opencode` 1.x (`opencode-ai`) reads the config at every start.
 * - `opencode` 2.x (`@opencode/cli`) and OpenCode Desktop are clients of one
 *   per-user background service (`opencode serve --service`). The service
 *   re-reads opencode.json about a second after it changes, so `on` and
 *   `off` reach both without a restart. A client's OPENCODE_CONFIG_CONTENT
 *   never reaches the shared service; `--standalone` runs a private server
 *   that does read it.
 */

/** True when aiand was pointed at a home of its own (tests, WSL). */
const scoped = (): boolean => Boolean(process.env.AIAND_HOME);

/**
 * `$XDG_CONFIG_HOME/opencode/opencode.json`, else `~/.config/...`, on every
 * platform: both OpenCode lines resolve it that way. Under AIAND_HOME the
 * variable describes the real home, so the scoped home wins.
 */
export function opencodeConfigDir(): string {
  const xdg = !scoped() && process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(agentHome(), ".config"), "opencode");
}

/** OpenCode Desktop's app bundle, when installed. Verified on macOS only. */
export function desktopAppPath(): string | null {
  if (process.platform !== "darwin") return null;
  const candidates = scoped()
    ? [join(agentHome(), "Applications", "OpenCode.app")]
    : ["/Applications/OpenCode.app", join(agentHome(), "Applications", "OpenCode.app")];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** The two npm packages that ship `opencode`, and the line each carries. */
const OPENCODE_PACKAGES = new Set(["opencode-ai", "@opencode/cli"]);

/**
 * The npm package version behind a resolved `opencode`, read from its
 * package.json without running it: `<pkg>/bin/opencode[.exe]` for both
 * `opencode-ai` (1.x) and `@opencode/cli` (2.x).
 */
function packageMajor(resolved: string): number | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(dirname(realpathSync(resolved))), "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (typeof pkg.name !== "string" || !OPENCODE_PACKAGES.has(pkg.name)) return null;
    const match = typeof pkg.version === "string" ? /^(\d+)\./.exec(pkg.version) : null;
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The major version of the `opencode` on PATH: 1 for `opencode-ai`, 2+ for
 * `@opencode/cli`; null when it cannot tell. npm installs are read from
 * their package.json; anything else (a standalone binary) is asked with
 * `--version` ("1.18.32" or "opencode v2.3.0"), for at most a few seconds.
 */
export function terminalMajor(bin: string): number | null {
  const resolved = detectBinary(bin).path;
  if (resolved === null) return null;
  const fromPackage = packageMajor(resolved);
  if (fromPackage !== null) return fromPackage;
  const env = { ...process.env };
  delete env.AIAND_API_KEY;
  let command = resolved;
  let args = ["--version"];
  let verbatim = false;
  if (process.platform === "win32") {
    const windows = resolveWindowsCommand(bin, args, env);
    if (!windows) return null;
    ({ command, args, verbatim } = windows);
  }
  const run = spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout: 5_000,
    windowsVerbatimArguments: verbatim,
  });
  if (run.error || run.status !== 0) return null;
  const match = /(?:^|\s|v)(\d+)\.\d+\.\d+/.exec(run.stdout);
  return match ? Number(match[1]) : null;
}

/** 2.x subcommands that take `--standalone`; the others refuse it. */
const STANDALONE_SUBCOMMANDS = new Set([
  "run",
  "mini",
  "api",
  "models",
  "stats",
  "session",
  "auth",
]);
const OTHER_SUBCOMMANDS = new Set([
  "acp",
  "mcp",
  "plugin",
  "debug",
  "service",
  "upgrade",
  "update",
  "uninstall",
]);

/**
 * `--standalone` for a 2.x launch whose routing rides OPENCODE_CONFIG_CONTENT
 * or a just-written config: the shared service would ignore the first and
 * may predate the second. Nothing when the args already choose a server, or
 * run a subcommand that takes no `--standalone`.
 */
export function standaloneArgs(args: string[]): string[] {
  if (
    args.some((arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="))
  ) {
    return [];
  }
  const first = args.find((arg) => !arg.startsWith("-"));
  if (first !== undefined && OTHER_SUBCOMMANDS.has(first)) return [];
  if (first !== undefined && !STANDALONE_SUBCOMMANDS.has(first) && args[0] !== first) {
    // A positional after flags we cannot parse: stay out of the way.
    return [];
  }
  return ["--standalone"];
}
