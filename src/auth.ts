// Loads and refreshes Codex CLI OAuth tokens from ~/.codex/auth.json.
//
// Uses the same refresh flow as the Codex CLI itself
// (POST https://auth.openai.com/oauth/token, client_id=app_EMoamEEZ73f0CkXaXp7hrann),
// so refreshes performed here are interchangeable with refreshes performed by
// the codex binary.

import { homedir } from "node:os";
import { join } from "node:path";

// Codex's well-known public OAuth client id. See codex-rs/login/src/auth/manager.rs.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_URL = "https://auth.openai.com/oauth/token";

// Refresh slightly before the access token actually expires so a request never
// races the upstream 401.
const REFRESH_SAFETY_WINDOW_MS = 60_000;

export type AuthFile = {
  OPENAI_API_KEY: string | null;
  auth_mode?: string;
  last_refresh?: string | null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
};

export type AuthSnapshot = {
  accessToken: string;
  accountId: string;
  expiresAt: number; // epoch ms; 0 if unknown
};

const DEFAULT_AUTH_PATH = join(homedir(), ".codex", "auth.json");

export class CodexAuth {
  private readonly path: string;
  private cached: AuthFile | null = null;
  private mtimeMs = 0;
  private inflightRefresh: Promise<void> | null = null;

  constructor(path: string = DEFAULT_AUTH_PATH) {
    this.path = path;
  }

  async snapshot(): Promise<AuthSnapshot> {
    const auth = await this.load();
    return toSnapshot(auth);
  }

  async refreshIfStale(): Promise<AuthSnapshot> {
    const snap = await this.snapshot();
    if (snap.expiresAt > 0 && Date.now() < snap.expiresAt - REFRESH_SAFETY_WINDOW_MS) {
      return snap;
    }
    await this.refresh();
    return this.snapshot();
  }

  async forceRefresh(): Promise<AuthSnapshot> {
    await this.refresh();
    return this.snapshot();
  }

  // Coalesces concurrent refreshes so a burst of 401s only triggers one network
  // request to the OAuth server.
  private refresh(): Promise<void> {
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this.refreshOnce().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  private async refreshOnce(): Promise<void> {
    const auth = await this.load();
    const refreshToken = auth.tokens.refresh_token;
    if (!refreshToken) {
      throw new Error(
        `codex auth.json at ${this.path} has no refresh_token; re-run \`codex login\``,
      );
    }

    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`codex token refresh failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
    };

    const updated: AuthFile = {
      ...auth,
      tokens: {
        id_token: data.id_token ?? auth.tokens.id_token,
        access_token: data.access_token ?? auth.tokens.access_token,
        refresh_token: data.refresh_token ?? auth.tokens.refresh_token,
        account_id:
          extractAccountId(data.id_token) ?? auth.tokens.account_id,
      },
      last_refresh: new Date().toISOString(),
    };

    await Bun.write(this.path, JSON.stringify(updated, null, 2));
    this.cached = updated;
    const stat = await Bun.file(this.path).stat();
    this.mtimeMs = stat.mtimeMs;
  }

  // Re-reads from disk if the file was rewritten by another process (e.g. a
  // running codex CLI that just refreshed its own tokens).
  private async load(): Promise<AuthFile> {
    const file = Bun.file(this.path);
    const stat = await file.stat().catch(() => null);
    if (!stat) {
      throw new Error(
        `codex auth.json not found at ${this.path}; run \`codex login\` first`,
      );
    }
    if (this.cached && stat.mtimeMs === this.mtimeMs) return this.cached;
    const text = await file.text();
    const parsed = JSON.parse(text) as AuthFile;
    if (!parsed?.tokens?.access_token) {
      throw new Error(
        `codex auth.json at ${this.path} has no access_token; run \`codex login\``,
      );
    }
    this.cached = parsed;
    this.mtimeMs = stat.mtimeMs;
    return parsed;
  }
}

function toSnapshot(auth: AuthFile): AuthSnapshot {
  return {
    accessToken: auth.tokens.access_token,
    accountId: auth.tokens.account_id,
    expiresAt: jwtExpiryMs(auth.tokens.access_token) ?? 0,
  };
}

function jwtExpiryMs(jwt: string): number | null {
  const claims = decodeJwtClaims(jwt);
  if (!claims) return null;
  const exp = claims["exp"];
  if (typeof exp !== "number") return null;
  return exp * 1000;
}

function extractAccountId(jwt: string | undefined): string | null {
  if (!jwt) return null;
  const claims = decodeJwtClaims(jwt);
  if (!claims) return null;
  // Codex stores this same value under tokens.account_id; the canonical claim
  // is the chatgpt account id namespaced under the OpenAI auth claim.
  const auth = claims["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  const id = auth?.["chatgpt_account_id"];
  return typeof id === "string" ? id : null;
}

function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const padded = payload + "==".slice(0, (4 - (payload.length % 4)) % 4);
    const json = Buffer.from(
      padded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
