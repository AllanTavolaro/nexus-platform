const assert = require("node:assert/strict");
const test = require("node:test");
const { MembershipRole } = require("@prisma/client");
const { MonitorsService } = require("../dist/monitors/monitors.service.js");
const { ScenarioSecretsService } = require("../dist/scenarios/scenario-secrets.service.js");
const { ScenariosService } = require("../dist/scenarios/scenarios.service.js");

const organizationAOwner = {
  id: "user-a",
  name: "User A",
  email: "a@example.test",
  organizationId: "organization-a",
  organizationName: "A",
  organizationSlug: "a",
  role: MembershipRole.OWNER,
};

test("monitor history checks organization ownership before reading results", async () => {
  const calls = [];
  const prisma = {
    monitor: {
      findFirst: async (args) => { calls.push(["monitor.findFirst", args]); return { id: "monitor-a" }; },
    },
    monitorCheck: {
      findMany: async (args) => { calls.push(["monitorCheck.findMany", args]); return []; },
    },
  };
  const service = new MonitorsService(prisma, {});

  await service.history(organizationAOwner, "monitor-a", 500);

  assert.deepEqual(calls[0][1].where, { id: "monitor-a", organizationId: "organization-a" });
  assert.deepEqual(calls[1][1].where, { monitor: { organizationId: "organization-a", id: "monitor-a" } });
  assert.equal(calls[1][1].take, 100);
});

test("a monitor from another organization is not readable", async () => {
  let readChecks = false;
  const service = new MonitorsService({
    monitor: { findFirst: async () => null },
    monitorCheck: { findMany: async () => { readChecks = true; return []; } },
  }, {});

  await assert.rejects(service.history(organizationAOwner, "monitor-b"), (error) => error.getStatus?.() === 404);
  assert.equal(readChecks, false);
});

test("scenario history is scoped to the signed-in organization", async () => {
  const calls = [];
  const prisma = {
    apiScenario: {
      findFirst: async (args) => { calls.push(["apiScenario.findFirst", args]); return { id: "scenario-a" }; },
    },
    apiScenarioRun: {
      findMany: async (args) => { calls.push(["apiScenarioRun.findMany", args]); return []; },
    },
  };
  const service = new ScenariosService(prisma, {}, {});

  await service.history(organizationAOwner, "scenario-a", 100);

  assert.deepEqual(calls[0][1].where, { id: "scenario-a", organizationId: "organization-a" });
  assert.deepEqual(calls[1][1].where, { scenario: { id: "scenario-a", organizationId: "organization-a" } });
  assert.equal(calls[1][1].take, 50);
});

test("credential listing returns organization metadata without ciphertext", async () => {
  let query;
  const service = new ScenarioSecretsService({
    scenarioSecret: { findMany: async (args) => { query = args; return []; } },
  });

  await service.list(organizationAOwner);

  assert.deepEqual(query.where, { organizationId: "organization-a" });
  assert.equal(Object.hasOwn(query.select, "ciphertext"), false);
  assert.equal(Object.hasOwn(query.select, "iv"), false);
  assert.equal(Object.hasOwn(query.select, "authTag"), false);
});

test("viewers cannot create monitors or scenarios", async () => {
  let writes = 0;
  const viewer = { ...organizationAOwner, role: MembershipRole.VIEWER };
  const monitors = new MonitorsService({ monitor: { create: async () => { writes += 1; } } }, {});
  const scenarios = new ScenariosService({ apiScenario: { create: async () => { writes += 1; } } }, {}, {});

  await assert.rejects(monitors.create(viewer, { name: "Monitor", url: "https://example.com" }), (error) => error.getStatus?.() === 403);
  await assert.rejects(scenarios.create(viewer, { name: "Scenario", method: "GET", url: "https://example.com", assertions: [] }), (error) => error.getStatus?.() === 403);
  assert.equal(writes, 0);
});
