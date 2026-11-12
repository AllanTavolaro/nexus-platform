const assert = require("node:assert/strict");
const test = require("node:test");
const { createDecipheriv } = require("node:crypto");
const { encryptScenarioSecret } = require("../dist/scenarios/scenario-secrets.crypto.js");

const testKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("encrypts credentials with authenticated AES-256-GCM ciphertext", () => {
  const previousKey = process.env.SCENARIO_SECRET_KEY;
  process.env.SCENARIO_SECRET_KEY = testKey;
  try {
    const plaintext = "Bearer private-token-value";
    const encrypted = encryptScenarioSecret(plaintext);

    assert.equal(encrypted.iv.length, 24);
    assert.equal(encrypted.authTag.length, 32);
    assert.notEqual(encrypted.ciphertext, plaintext);
    assert.equal(JSON.stringify(encrypted).includes(plaintext), false);

    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(testKey, "hex"), Buffer.from(encrypted.iv, "hex"));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "hex"));
    const roundTrip = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    assert.equal(roundTrip, plaintext);
  } finally {
    if (previousKey === undefined) delete process.env.SCENARIO_SECRET_KEY;
    else process.env.SCENARIO_SECRET_KEY = previousKey;
  }
});

test("uses a fresh IV when encrypting the same credential twice", () => {
  const previousKey = process.env.SCENARIO_SECRET_KEY;
  process.env.SCENARIO_SECRET_KEY = testKey;
  try {
    const first = encryptScenarioSecret("same-value");
    const second = encryptScenarioSecret("same-value");
    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
  } finally {
    if (previousKey === undefined) delete process.env.SCENARIO_SECRET_KEY;
    else process.env.SCENARIO_SECRET_KEY = previousKey;
  }
});

test("fails closed when the encryption key is missing or malformed", () => {
  const previousKey = process.env.SCENARIO_SECRET_KEY;
  try {
    delete process.env.SCENARIO_SECRET_KEY;
    assert.throws(() => encryptScenarioSecret("value"), /64 hexadecimal characters/);
    process.env.SCENARIO_SECRET_KEY = "not-a-key";
    assert.throws(() => encryptScenarioSecret("value"), /64 hexadecimal characters/);
  } finally {
    if (previousKey === undefined) delete process.env.SCENARIO_SECRET_KEY;
    else process.env.SCENARIO_SECRET_KEY = previousKey;
  }
});
