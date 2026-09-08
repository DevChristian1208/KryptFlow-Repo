import { bufToBase64, base64ToBuf, type ChannelKeyEnvelope } from "./crypto";

export async function importBotPrivateKeys(
  ecdhPrivateJwk: JsonWebKey,
  ecdsaPrivateJwk: JsonWebKey
) {
  const ecdhPrivateKey = await crypto.subtle.importKey(
    "jwk",
    ecdhPrivateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
  const ecdsaPrivateKey = await crypto.subtle.importKey(
    "jwk",
    ecdsaPrivateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"]
  );
  return { ecdhPrivateKey, ecdsaPrivateKey };
}

export async function unwrapChannelKeyServer(
  ecdhPrivateKey: CryptoKey,
  envelope: ChannelKeyEnvelope
): Promise<CryptoKey> {
  const ephemeralPublicKey = await crypto.subtle.importKey(
    "jwk",
    envelope.ephemeralPublicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: ephemeralPublicKey },
    ecdhPrivateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["unwrapKey"]
  );
  return crypto.subtle.unwrapKey(
    "raw",
    base64ToBuf(envelope.wrappedKey),
    wrappingKey,
    { name: "AES-GCM", iv: base64ToBuf(envelope.iv) },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function encryptTextServer(
  key: CryptoKey,
  plaintext: string
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return { ciphertext: bufToBase64(buf), iv: bufToBase64(iv.buffer) };
}

export async function signTextServer(
  ecdsaPrivateKey: CryptoKey,
  text: string
): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    ecdsaPrivateKey,
    new TextEncoder().encode(text)
  );
  return bufToBase64(sig);
}

// Muss mit CHANNEL_EPOCH_DURATION_MS in ChannelContext.tsx übereinstimmen.
export const CHANNEL_EPOCH_DURATION_MS = 24 * 60 * 60 * 1000;

export function epochIdForTimestampServer(at: number = Date.now()): string {
  return String(Math.floor(at / CHANNEL_EPOCH_DURATION_MS));
}
