import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GatewayAuthResolution {
  mode?: string;
  token?: string;
  source: "env" | "config" | "none";
  error?: string;
}

export async function resolveGatewayAuth(env: NodeJS.ProcessEnv = process.env): Promise<GatewayAuthResolution> {
  const envToken = normalizeSecret(env.OPENCLAW_GATEWAY_TOKEN);
  if (envToken) return { mode: "token", token: envToken, source: "env" };

  const configPath = env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw) as { gateway?: { auth?: { mode?: unknown; token?: unknown } } };
    const auth = config.gateway?.auth;
    const mode = typeof auth?.mode === "string" ? auth.mode : undefined;
    const token = normalizeSecret(auth?.token);
    return { mode, token, source: token ? "config" : "none" };
  } catch (error) {
    return {
      source: "none",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function normalizeSecret(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value !== "__OPENCLAW_REDACTED__" ? value.trim() : undefined;
}
