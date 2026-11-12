const path = require("node:path");
process.chdir(path.resolve(__dirname, "../apps/api"));

require("reflect-metadata");

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const dotenv = require("dotenv");
const cookieParser = require("cookie-parser");
const Redis = require("ioredis");
const { ValidationPipe } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../apps/api/dist/app.module.js");
const { PrismaService } = require("../apps/api/dist/prisma/prisma.service.js");

dotenv.config({ path: path.resolve(__dirname, "../.env") });
const rateLimitPrefix = `nexus:integration:${randomUUID()}`;
process.env.RATE_LIMIT_PREFIX = rateLimitPrefix;

function assertStatus(response, expected, label) {
  assert.equal(response.status, expected, `${label}: expected HTTP ${expected}, received ${response.status}; body=${JSON.stringify(response.body)}`);
}

function sessionCookie(response) {
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/^nexus_session=([^;]+)/);
  assert.ok(match, "registration response must set the nexus_session cookie");
  return `nexus_session=${match[1]}`;
}

async function main() {
  for (const key of ["DATABASE_URL", "REDIS_URL", "JWT_SECRET", "SCENARIO_SECRET_KEY"]) {
    if (!process.env[key]) throw new Error(`Set ${key} before running the integration smoke test.`);
  }

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));

  const organizationIds = [];
  const userIds = [];
  let passed = false;

  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address === "object", "API must bind to an ephemeral local port");
    const origin = `http://127.0.0.1:${address.port}/api`;

    async function request(route, { method = "GET", cookie, body } = {}) {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, headers: response.headers, body: parsed };
    }

    const readiness = await request("/health/ready");
    assertStatus(readiness, 200, "dependency readiness");
    assert.deepEqual(readiness.body.checks, { database: "ok", redis: "ok" });

    const noSession = await request("/monitors");
    assertStatus(noSession, 401, "unauthenticated monitor list");

    const suffix = randomUUID();
    const register = async (name, organizationName, userSuffix) => {
      const response = await request("/auth/register", {
        method: "POST",
        body: {
          name,
          organizationName,
          email: `nexus-ci-${userSuffix}-${suffix}@example.com`,
          password: "nexus-integration-password-2026!",
        },
      });
      assertStatus(response, 201, `${name} registration`);
      assert.ok(response.body?.user?.id && response.body?.organization?.id, `${name} registration must return tenant identifiers`);
      organizationIds.push(response.body.organization.id);
      userIds.push(response.body.user.id);
      return { cookie: sessionCookie(response), user: response.body.user, organization: response.body.organization };
    };

    const alice = await register("Integration Alice", "Integration Org Alpha", "alice");
    const bob = await register("Integration Bob", "Integration Org Beta", "bob");

    const me = await request("/auth/me", { cookie: alice.cookie });
    assertStatus(me, 200, "session identity");
    assert.equal(me.body.user.id, alice.user.id);
    assert.equal(me.body.organization.id, alice.organization.id);
    assert.equal(me.body.organization.role, "OWNER");

    const prisma = app.get(PrismaService);
    const seededMonitor = await prisma.monitor.create({
      data: {
        organizationId: alice.organization.id,
        name: "Integration tenant monitor",
        url: "https://example.test/health",
        intervalSec: 3600,
      },
      select: { id: true },
    });

    const aliceMonitors = await request("/monitors", { cookie: alice.cookie });
    assertStatus(aliceMonitors, 200, "organization monitor list");
    assert.equal(aliceMonitors.body.length, 1);
    assert.equal(aliceMonitors.body[0].id, seededMonitor.id);

    const bobMonitors = await request("/monitors", { cookie: bob.cookie });
    assertStatus(bobMonitors, 200, "second organization monitor list");
    assert.deepEqual(bobMonitors.body, []);

    const crossTenantMonitor = await request(`/monitors/${seededMonitor.id}/history`, { cookie: bob.cookie });
    assertStatus(crossTenantMonitor, 404, "cross-organization monitor history");

    const scenario = await request("/scenarios", {
      method: "POST",
      cookie: alice.cookie,
      body: {
        name: "Integration scenario",
        collectionName: "CI smoke",
        method: "GET",
        url: "https://example.test/health",
        assertions: [{ type: "STATUS_CODE", expected: "200" }],
      },
    });
    assertStatus(scenario, 201, "scenario creation");
    assert.ok(scenario.body?.id, "scenario creation must return an id");

    const aliceScenarios = await request("/scenarios", { cookie: alice.cookie });
    assertStatus(aliceScenarios, 200, "organization scenario list");
    assert.equal(aliceScenarios.body.length, 1);
    assert.equal(aliceScenarios.body[0].id, scenario.body.id);

    const bobScenarios = await request("/scenarios", { cookie: bob.cookie });
    assertStatus(bobScenarios, 200, "second organization scenario list");
    assert.deepEqual(bobScenarios.body, []);

    const crossTenantScenario = await request(`/scenarios/${scenario.body.id}/runs`, { cookie: bob.cookie });
    assertStatus(crossTenantScenario, 404, "cross-organization scenario history");

    const secretValue = `Bearer integration-${suffix}`;
    const secret = await request("/scenario-secrets", {
      method: "POST",
      cookie: alice.cookie,
      body: { name: "CI credential", type: "API_CREDENTIAL", value: secretValue },
    });
    assertStatus(secret, 201, "encrypted credential creation");
    assert.ok(secret.body?.id, "credential creation must return an id");
    assert.equal(JSON.stringify(secret.body).includes(secretValue), false, "credential response must not expose the value");
    for (const field of ["ciphertext", "iv", "authTag"]) assert.equal(field in secret.body, false, `credential response must omit ${field}`);

    const aliceSecrets = await request("/scenario-secrets", { cookie: alice.cookie });
    assertStatus(aliceSecrets, 200, "organization credential list");
    assert.equal(aliceSecrets.body.length, 1);
    assert.equal(JSON.stringify(aliceSecrets.body).includes(secretValue), false, "credential list must not expose the value");
    const bobSecrets = await request("/scenario-secrets", { cookie: bob.cookie });
    assertStatus(bobSecrets, 200, "second organization credential list");
    assert.deepEqual(bobSecrets.body, []);

    await prisma.membership.update({
      where: { userId_organizationId: { userId: alice.user.id, organizationId: alice.organization.id } },
      data: { role: "VIEWER" },
    });

    const viewerMonitorWrite = await request("/monitors", {
      method: "POST",
      cookie: alice.cookie,
      body: { name: "Viewer write should fail", url: "https://example.test", intervalSec: 3600 },
    });
    assertStatus(viewerMonitorWrite, 403, "viewer monitor write");

    const viewerScenarioWrite = await request("/scenarios", {
      method: "POST",
      cookie: alice.cookie,
      body: {
        name: "Viewer write should fail",
        method: "GET",
        url: "https://example.test",
        assertions: [{ type: "STATUS_CODE", expected: "200" }],
      },
    });
    assertStatus(viewerScenarioWrite, 403, "viewer scenario write");

    const viewerSecretWrite = await request("/scenario-secrets", {
      method: "POST",
      cookie: alice.cookie,
      body: { name: "Viewer write should fail", type: "API_CREDENTIAL", value: "Bearer denied" },
    });
    assertStatus(viewerSecretWrite, 403, "viewer credential write");

    const loginEmail = `nexus-ci-rate-${suffix}@example.com`;
    let loginThrottled;
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      loginThrottled = await request(attempt === 11 ? "/auth/login/" : "/auth/login", {
        method: "POST",
        body: { email: loginEmail, password: "incorrect-integration-password" },
      });
      assertStatus(loginThrottled, attempt <= 10 ? 401 : 429, `login rate-limit attempt ${attempt}`);
    }
    assert.ok(Number(loginThrottled.headers.get("retry-after")) >= 1, "throttled login must include Retry-After");

    passed = true;
    console.log("Integration smoke passed: readiness, registration/session, tenant isolation, credential redaction, viewer permissions, and shared Redis rate limiting.");
  } finally {
    try {
      const prisma = app.get(PrismaService);
      if (organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
      if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      const redis = new Redis(process.env.REDIS_URL, { connectTimeout: 2000, maxRetriesPerRequest: 1 });
      try {
        let cursor = "0";
        do {
          const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${rateLimitPrefix}:*`, "COUNT", "100");
          cursor = nextCursor;
          if (keys.length) await redis.del(...keys);
        } while (cursor !== "0");
      } finally {
        await redis.quit();
      }
    } catch (error) {
      console.error("Integration smoke cleanup failed:", error);
      process.exitCode = 1;
    } finally {
      await app.close();
    }
    if (!passed) console.error("Integration smoke failed before all assertions completed; test rows were removed where possible.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
