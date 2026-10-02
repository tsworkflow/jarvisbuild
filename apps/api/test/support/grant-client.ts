import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * Remediering del 2 (JARVIS-001): test-hjelper som henter et ekte, server-utstedt
 * grant via den kanoniske veien (`/devices/challenge` → signert nonce →
 * `/session/authorize`) - samme vei en klient bruker. Ingen test skal lenger
 * sende en identitet i kroppen til en kontrollrute.
 */
export interface TestDeviceKey {
  privateKey: KeyObject;
  publicKeyPem: string;
}

export function generateDeviceKey(): TestDeviceKey {
  const keys = generateKeyPairSync("ed25519");
  return { privateKey: keys.privateKey, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
}

export interface GrantSubject {
  device_id: string;
  person_id: string;
  tenant_id: string;
  memory_space: string;
  channel?: string;
}

export async function mintGrant(baseUrl: string, subject: GrantSubject, key: TestDeviceKey): Promise<string> {
  const post = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const issued = await post("/devices/challenge", { device_id: subject.device_id });
  const challenge = issued.body["challenge"] as string | undefined;
  if (typeof challenge !== "string") {
    throw new Error(`mintGrant_challenge_failed:${issued.status}:${JSON.stringify(issued.body)}`);
  }
  const signature = sign(null, Buffer.from(challenge, "utf8"), key.privateKey).toString("base64");
  const authorized = await post("/session/authorize", {
    channel: subject.channel ?? "api", person_id: subject.person_id, tenant_id: subject.tenant_id,
    device_id: subject.device_id, memory_space: subject.memory_space, device_proof: { challenge, signature }
  });
  if (authorized.status !== 200) {
    throw new Error(`mintGrant_failed:${authorized.status}:${JSON.stringify(authorized.body)}`);
  }
  return (authorized.body["grant"] as Record<string, unknown>)["grant_token"] as string;
}
