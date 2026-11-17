import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentHome } from "../../config.js";
import { detectBinary } from "../detect.js";
import { readJsoncObject } from "../managed-file.js";
import { createPiFamily } from "../pi/family.js";
import { PI_PROVIDER_ID } from "../pi/ownership.js";
import type { AgentAdapter, DetectResult } from "../types.js";

const JOUZU_ID = "jouzu";
const JOUZU_BIN = "jouzu";
/** Jouzu installs the same entry point under a short name too. */
const JOUZU_SHORT_BIN = "jz";

/**
 * Jouzu's root: $JOUZU_HOME when set, otherwise its per-platform config dir
 * (packages/cli/src/paths.ts resolveJouzuPaths, Jouzu 0.2.x). Under
 * AIAND_HOME the scoped home stands in for the OS home, and APPDATA /
 * XDG_CONFIG_HOME are ignored: they describe the real home, not the one
 * aiand was pointed at.
 */
function jouzuConfigDir(): string {
  const override = process.env.JOUZU_HOME?.trim();
  if (override) {
    // Jouzu expands a leading ~ and resolves a relative path against cwd.
    return resolve(override.replace(/^~(?=$|[/\\])/, homedir()));
  }
  const scoped = Boolean(process.env.AIAND_HOME);
  const home = agentHome();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Jouzu");
  }
  if (process.platform === "win32") {
    const roaming = (!scoped && process.env.APPDATA?.trim()) || join(home, "AppData", "Roaming");
    return join(roaming, "Jouzu");
  }
  const configHome = (!scoped && process.env.XDG_CONFIG_HOME?.trim()) || join(home, ".config");
  return join(configHome, "jouzu");
}

/**
 * Jouzu runs Pi with PI_CODING_AGENT_DIR pinned to `<root>/agent`, so Pi's
 * own models.json, auth.json and settings.json live there, and the wiring is
 * Pi's, file for file. A PI_CODING_AGENT_DIR of the user's never reaches
 * Jouzu: it overwrites the variable at startup.
 */
function jouzuAgentDir(): string {
  return join(jouzuConfigDir(), "agent");
}

const jouzu = createPiFamily({
  id: JOUZU_ID,
  label: "Jouzu",
  agentDir: jouzuAgentDir,
  dirEnv: "JOUZU_HOME",
});

/**
 * Args that already decide the model or the session (Pi's flags, which
 * Jouzu passes through), that name Jouzu's own options, or that run a Jouzu
 * management command. `open` adds nothing when any of these is present.
 */
const DECIDING_FLAGS = new Set([
  "--model",
  "--models",
  "--provider",
  "--api-key",
  "--session",
  "--session-id",
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--help",
  "-h",
  "--version",
  "-v",
  "--",
]);
const SUBCOMMANDS = new Set([
  "acp",
  "doctor",
  "catalog",
  "profile",
  "profile-migration",
  "keybindings",
  "self-update",
  "pi",
  "help",
]);

function argsDecide(args: string[]): boolean {
  if (args.length > 0 && SUBCOMMANDS.has(args[0] as string)) return true;
  return args.some((arg) => {
    const flag = arg.split("=", 1)[0] as string;
    return DECIDING_FLAGS.has(flag) || flag.startsWith("--jouzu-");
  });
}

/**
 * The Jouzu release the install hint pins: the newest one at least seven
 * days old when this was written, matching the release-age rule the repo
 * applies to its own dependencies. Jouzu updates a global npm install
 * itself at launch, so this only decides the first install. CI installs
 * the same release for scripts/jouzu-smoke.mjs.
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const JOUZU_VERSION = "0.2.5";

export const jouzuAdapter: AgentAdapter = {
  id: JOUZU_ID,
  label: "Jouzu",
  bin: JOUZU_BIN,
  aliases: [JOUZU_SHORT_BIN],
  install: {
    command: `npm install -g --ignore-scripts jouzu@${JOUZU_VERSION}`,
    url: "https://github.com/shisa-ai/jouzu",
  },
  // "--model native" leaves the model unpinned, as for Pi.
  allowUnpinnedModel: true,
  detect(): DetectResult {
    const full = detectBinary(JOUZU_BIN);
    return full.installed ? full : detectBinary(JOUZU_SHORT_BIN);
  },
  managedFiles: jouzu.managedFiles,
  probe: jouzu.probe,
  enable: jouzu.enable,
  disable: jouzu.disable,
  refreshKey: jouzu.refreshKey,
  // No sessionLaunch: Jouzu derives its agent dir from JOUZU_HOME, which
  // also moves its sessions, state and first-run setup, so a throwaway
  // overlay would hide the user's history. `on` is the route.
  async openExtras({ args }) {
    // Jouzu starts on its project default or last-used model before
    // settings.json's defaultModel, so a model picked before `on` would
    // still decide. `aiand jouzu` names the ai& model `on` wired, for this
    // run only; nothing is written. Under --model native (no aiand
    // default provider) Jouzu's own choice stands.
    if (argsDecide(args)) return {};
    const settings = await readJsoncObject(jouzu.settingsPath()).catch(
      () => ({}) as Record<string, unknown>,
    );
    if (settings.defaultProvider !== PI_PROVIDER_ID) return {};
    if (typeof settings.defaultModel !== "string" || settings.defaultModel === "") return {};
    return { args: ["--provider", PI_PROVIDER_ID, "--model", settings.defaultModel] };
  },
};
