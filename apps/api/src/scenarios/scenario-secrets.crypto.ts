import { createCipheriv, randomBytes } from "node:crypto";

export type EncryptedScenarioSecret = { ciphertext: string; iv: string; authTag: string };

function encryptionKey() {
  const configured = process.env.SCENARIO_SECRET_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(configured)) {
    throw new Error("SCENARIO_SECRET_KEY must be set to 64 hexadecimal characters in the root .env file.");
  }
  return Buffer.from(configured, "hex");
}

export function encryptScenarioSecret(value: string): EncryptedScenarioSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}
