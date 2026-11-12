const assert = require("node:assert/strict");
const test = require("node:test");
const { isPublicAddress, lookupPublicAddresses, parseHttpTarget } = require("../dist/target-security.js");

test("accepts only credential-free HTTP targets on standard ports", () => {
  assert.equal(parseHttpTarget("https://status.example.com/health").hostname, "status.example.com");
  assert.equal(parseHttpTarget("http://status.example.com:80/health").port, "");
  assert.equal(parseHttpTarget("https://status.example.com:443/health").port, "");

  for (const value of [
    "file:///etc/passwd",
    "ftp://status.example.com/",
    "https://user:password@status.example.com/",
    "https://status.example.com:8443/",
    "not a URL",
  ]) {
    assert.throws(() => parseHttpTarget(value), { name: "Error" }, value);
  }
});

test("classifies public addresses and rejects non-public ranges", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }

  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "not-an-ip",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("checks literal IP addresses without doing DNS resolution", async () => {
  await assert.rejects(lookupPublicAddresses("[::1]"), /non-public network address/);
  assert.deepEqual(await lookupPublicAddresses("8.8.8.8"), [{ address: "8.8.8.8", family: 4 }]);
});

test("rejects a hostname when any DNS answer is non-public", async () => {
  await assert.rejects(
    lookupPublicAddresses("mixed.example", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]),
    /non-public network address/,
  );
});

test("rejects a hostname when DNS returns no addresses", async () => {
  await assert.rejects(lookupPublicAddresses("empty.example", async () => []), /non-public network address/);
});

test("accepts hostnames only when all DNS answers are public", async () => {
  const result = await lookupPublicAddresses("public.example", async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  assert.equal(result.length, 2);
});
