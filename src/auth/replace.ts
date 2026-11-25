import { revokeTokens } from "../api/device.js";
import { CliError } from "../cli/errors.js";
import { err, safeLine, style } from "../cli/output.js";
import {
  CONSOLE_KEYS_URL,
  CREDENTIAL_ORIGIN,
  type CredentialBinding,
  issuerBinding,
  type LoadedCredential,
  loadCredential,
  redactUrl,
  storedBinding,
  unprovenIssuer,
} from "../config.js";

/** What a login replacing `previous` needs to retire it. The issuer is read
 * before the login runs: a login can rewrite config.json, which is where an
 * unbound sign-in takes its issuer from. */
export type ReplacedSignIn = {
  profile: string;
  previous: LoadedCredential;
  binding: CredentialBinding | null;
};

export async function noteReplacedSignIn(
  profile: string,
  previous: LoadedCredential,
): Promise<ReplacedSignIn> {
  const minted = previous.origin !== CREDENTIAL_ORIGIN.PASTE && Boolean(previous.refresh_token);
  return {
    profile,
    previous,
    binding: minted ? await issuerBinding(profile, previous) : null,
  };
}

/** The sign-in about to be saved: its refresh token, if it has one, and where it was issued. */
export type IncomingSignIn = { refreshToken?: string; binding: CredentialBinding };

type RetireOutcome = "revoked" | "kept" | "failed" | "pasted" | "unrevocable" | "unchanged";

export type RetireResult = {
  outcome: RetireOutcome;
  /** The replaced key, for scrubbing its copies once the new sign-in is saved. */
  key?: string;
};

export type RetireOptions = {
  keepRemote?: boolean;
  /** Asks whether to replace the sign-in although its key could not be revoked. Absent off a terminal. */
  ask?: (question: string) => Promise<boolean>;
};

/**
 * Revoke the key the replaced sign-in minted. Runs under the profile's refresh
 * lock, after the new tokens arrive and before they are saved, so the old
 * refresh token is still on disk while it is spent: a revoke that fails leaves
 * both sign-ins in hand. Then it asks, or, off a terminal, revokes the new key
 * and throws, keeping the old sign-in. Everything goes to stderr, so `--json`
 * stdout stays one JSON document.
 */
export async function retireBeforeSave(
  replaced: ReplacedSignIn,
  incoming: IncomingSignIn,
  opts: RetireOptions = {},
): Promise<RetireResult> {
  const { profile, previous } = replaced;
  // Re-read under the lock: the sign-in may have rotated during a slow browser login.
  let target = previous;
  try {
    const now = await loadCredential(profile);
    if (!now) return { outcome: "unchanged" };
    target = now;
  } catch {
    // An unreadable store: the copy read when login started is the best there is.
  }
  const binding =
    target.access_token === previous.access_token
      ? replaced.binding
      : (storedBinding(target) ?? replaced.binding);
  const key = target.access_token;
  const stillValid = `The key "${profile}" signed in with before is still valid. Revoke it at ${CONSOLE_KEYS_URL} if you no longer need it.`;

  if (target.origin === CREDENTIAL_ORIGIN.PASTE) {
    err(style.dim(`The replaced key was pasted, so this CLI did not revoke it. ${stillValid}`));
    return { outcome: "pasted", key };
  }
  if (opts.keepRemote) {
    err(style.dim(`--keep-remote: the replaced key was not revoked. ${stillValid}`));
    return { outcome: "kept", key };
  }
  if (!target.refresh_token) {
    err(
      style.dim(
        `No refresh token was stored for the replaced key, so it could not be revoked. ${stillValid}`,
      ),
    );
    return { outcome: "unrevocable", key };
  }
  if (!binding) {
    err(style.yellow(unprovenIssuer(profile, "its key was not revoked").message));
    err(style.dim(stillValid));
    return { outcome: "unrevocable", key };
  }

  const result = await revokeTokens(binding.auth_url, target.refresh_token);
  if (result.revoked) {
    err(style.dim("Revoked the key this profile signed in with before."));
    return { outcome: "revoked", key };
  }
  const cause =
    result.status === undefined
      ? "the request did not reach it"
      : `it answered HTTP ${result.status}`;
  err(
    style.yellow(
      `Could not revoke the key "${profile}" signed in with before, at ${safeLine(redactUrl(binding.auth_url))}: ${cause}.`,
    ),
  );
  if (
    opts.ask &&
    (await opts.ask(
      "Replace the sign-in anyway? Its old key stays valid until you revoke it in the console.",
    ))
  ) {
    err(style.dim(stillValid));
    return { outcome: "failed", key };
  }
  // The new key was minted for nothing: revoke it, so keeping the old sign-in leaves no stray key.
  if (incoming.refreshToken) await revokeTokens(incoming.binding.auth_url, incoming.refreshToken);
  throw new CliError(`Kept the existing sign-in for "${profile}".`, {
    hint: `Try again later, or run \`aiand login --force --keep-remote\` to replace it and leave the old key valid, then revoke it at ${CONSOLE_KEYS_URL}.`,
  });
}
