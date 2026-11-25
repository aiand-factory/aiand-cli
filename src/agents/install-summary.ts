import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { detectBinary } from "./detect.js";
import { AGENTS } from "./registry.js";
import type { AgentAdapter } from "./types.js";

const CHECK = "\u2713";

/** PATH coding agents, in registry order. A GUI app (configOnly) has no binary to probe. */
function pathAgents(agents: readonly AgentAdapter[]): AgentAdapter[] {
  return agents.filter((agent) => agent.configOnly !== true);
}

/**
 * The post-install summary. `onPath` is the PATH probe (`detectBinary` when
 * the installers run this file). Each hint is that adapter's own
 * `install.command` for this process, so the omp and Hermes lines are the
 * platform-specific ones the CLI already prints.
 */
export function formatAgentSummary(
  agents: readonly AgentAdapter[],
  onPath: (bin: string) => boolean,
): string {
  const listed = pathAgents(agents);
  const detected = listed.filter((agent) => onPath(agent.bin));
  const missing = listed.filter((agent) => !onPath(agent.bin));
  const hint = (agent: AgentAdapter): string =>
    `  ${agent.id}  Install it with: ${agent.install.command}`;
  if (detected.length === 0) {
    return [
      "No coding agents detected on this machine.",
      ...listed.map(hint),
      "Install one, then run 'aiand init'.",
      "",
    ].join("\n");
  }
  return [
    "Detected agents:",
    ...detected.map((agent) => `  ${CHECK} ${agent.id}`),
    ...(missing.length > 0 ? ["Not installed:", ...missing.map(hint)] : []),
    "Next: run 'aiand init' to wire them to ai&.",
    "",
  ].join("\n");
}

function runningAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runningAsScript()) {
  process.stdout.write(formatAgentSummary(AGENTS, (bin) => detectBinary(bin).installed));
}
