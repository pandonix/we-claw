import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export async function loadDeviceIdentity(env: NodeJS.ProcessEnv = process.env): Promise<DeviceIdentity | undefined> {
  const stateDir = env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  const raw = await readFile(join(stateDir, "identity", "device.json"), "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Partial<DeviceIdentity> & { version?: unknown };
  if (parsed.version !== 1 || !parsed.deviceId || !parsed.publicKeyPem || !parsed.privateKeyPem) return undefined;
  return {
    deviceId: parsed.deviceId,
    publicKeyPem: parsed.publicKeyPem,
    privateKeyPem: parsed.privateKeyPem
  };
}

export function buildDeviceAuth(params: {
  identity: DeviceIdentity;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  token?: string;
  nonce: string;
  platform?: string;
  deviceFamily?: string;
}): { id: string; publicKey: string; signature: string; signedAt: number; nonce: string } {
  const signedAt = Date.now();
  const payload = [
    "v3",
    params.identity.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(signedAt),
    params.token ?? "",
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily)
  ].join("|");

  return {
    id: params.identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem),
    signature: base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(params.identity.privateKeyPem))),
    signedAt,
    nonce: params.nonce
  };
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const raw =
    spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
      ? spki.subarray(ED25519_SPKI_PREFIX.length)
      : spki;
  return base64UrlEncode(raw);
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function normalizeDeviceMetadataForAuth(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}
