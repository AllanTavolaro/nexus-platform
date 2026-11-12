import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ApiScenarioMethod, MembershipRole, Prisma, ScenarioAssertionType, ScenarioSecretType } from "@prisma/client";
import { SessionUser } from "../auth/session-user";
import { PrismaService } from "../prisma/prisma.service";
import { CreateScenarioDto, ImportScenariosDto, RunScenarioCollectionDto, UpdateScenarioDto } from "./scenario.dto";
import { ScenarioSecretsService } from "./scenario-secrets.service";
import { ScenarioQueueService } from "./scenario-queue.service";

const latestRunSelect = {
  id: true,
  status: true,
  responseStatusCode: true,
  responseTimeMs: true,
  error: true,
  queuedAt: true,
  completedAt: true,
  trigger: true,
} satisfies Prisma.ApiScenarioRunSelect;

const sensitiveHeaders = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "x-auth-token"]);
const forbiddenHeaders = new Set(["host", "cookie", "set-cookie", "content-length", "connection", "transfer-encoding", "proxy-connection", "keep-alive", "upgrade", "te", "trailer", "expect", "accept-encoding"]);
type HeaderInput = { name: string; value?: string; secretId?: string; prefix?: string };

@Injectable()
export class ScenariosService {
  constructor(private readonly prisma: PrismaService, private readonly queue: ScenarioQueueService, private readonly secrets: ScenarioSecretsService) {}

  async list(user: SessionUser) {
    return this.prisma.apiScenario.findMany({
      where: { organizationId: user.organizationId },
      select: {
        id: true,
        collectionName: true,
        name: true,
        method: true,
        url: true,
        body: true,
        assertions: true,
        headers: true,
        scheduleIntervalSec: true,
        slackWebhookSecretId: true,
        createdAt: true,
        updatedAt: true,
        runs: { select: latestRunSelect, orderBy: { queuedAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async create(user: SessionUser, input: CreateScenarioDto) {
    this.requireWriteAccess(user);
    const url = this.normalizeUrl(input.url);
    this.validateAssertions(input.assertions);
    const headers = await this.normalizeHeaders(user.organizationId, input.headers ?? []);
    const scheduleIntervalSec = this.normalizeSchedule(input.scheduleIntervalSec ?? null);
    const slackWebhookSecretId = input.slackWebhookSecretId ?? null;
    if (slackWebhookSecretId) await this.secrets.encryptedForScenario(user.organizationId, slackWebhookSecretId, ScenarioSecretType.SLACK_WEBHOOK);
    const scenario = await this.prisma.apiScenario.create({
      data: {
        organizationId: user.organizationId,
        collectionName: input.collectionName?.trim() || "Geral",
        name: input.name,
        method: input.method as ApiScenarioMethod,
        url,
        body: input.body?.trim() || null,
        assertions: input.assertions as unknown as Prisma.InputJsonValue,
        headers: headers as unknown as Prisma.InputJsonValue,
        scheduleIntervalSec,
        slackWebhookSecretId,
      },
    });
    if (scheduleIntervalSec === null) return scenario;
    try {
      await this.queue.schedule(scenario.id, scheduleIntervalSec);
    } catch {
      try { await this.queue.removeSchedule(scenario.id); } catch { /* The scheduler may not exist yet. */ }
      await this.prisma.apiScenario.delete({ where: { id: scenario.id } });
      throw new ServiceUnavailableException("The scenario schedule could not be created. Try again shortly.");
    }
    return scenario;
  }

  async importScenarios(user: SessionUser, input: ImportScenariosDto) {
    this.requireWriteAccess(user);
    const collectionName = input.collectionName.trim();
    const requests = input.requests.map((request) => ({
      organizationId: user.organizationId,
      collectionName,
      name: request.name,
      method: request.method as ApiScenarioMethod,
      url: this.normalizeUrl(request.url),
      body: request.body?.trim() || null,
      assertions: [{ type: ScenarioAssertionType.STATUS_CODE, expected: "200" }] as unknown as Prisma.InputJsonValue,
      headers: [] as unknown as Prisma.InputJsonValue,
    }));

    return this.prisma.$transaction(async (tx) => {
      const imported: Prisma.ApiScenarioGetPayload<{}>[] = [];
      for (const data of requests) imported.push(await tx.apiScenario.create({ data }));
      return imported;
    });
  }

  async update(user: SessionUser, id: string, input: UpdateScenarioDto) {
    this.requireWriteAccess(user);
    const current = await this.findOwned(user, id);
    const data: Prisma.ApiScenarioUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.collectionName !== undefined) data.collectionName = input.collectionName;
    if (input.method !== undefined) data.method = input.method as ApiScenarioMethod;
    if (input.url !== undefined) data.url = this.normalizeUrl(input.url);
    if (input.body !== undefined) data.body = input.body?.trim() || null;
    if (input.assertions !== undefined) {
      this.validateAssertions(input.assertions);
      data.assertions = input.assertions as unknown as Prisma.InputJsonValue;
    }
    if (input.headers !== undefined) {
      if (!Array.isArray(input.headers)) throw new BadRequestException("Request headers must be an array.");
      data.headers = await this.normalizeHeaders(user.organizationId, input.headers) as unknown as Prisma.InputJsonValue;
    }
    const nextInterval = input.scheduleIntervalSec === undefined ? current.scheduleIntervalSec : this.normalizeSchedule(input.scheduleIntervalSec);
    if (input.scheduleIntervalSec !== undefined) data.scheduleIntervalSec = nextInterval;
    if (input.slackWebhookSecretId !== undefined) {
      const secretId = input.slackWebhookSecretId || null;
      if (secretId) await this.secrets.encryptedForScenario(user.organizationId, secretId, ScenarioSecretType.SLACK_WEBHOOK);
      data.slackWebhookSecret = secretId ? { connect: { id: secretId } } : { disconnect: true };
    }
    const updated = await this.prisma.apiScenario.update({ where: { id: current.id }, data });
    const scheduleChanged = nextInterval !== current.scheduleIntervalSec;
    if (!scheduleChanged) return updated;
    try {
      if (nextInterval === null) await this.queue.removeSchedule(current.id);
      else await this.queue.schedule(current.id, nextInterval);
    } catch {
      const restore: Prisma.ApiScenarioUpdateInput = {
        collectionName: current.collectionName,
        name: current.name,
        method: current.method,
        url: current.url,
        body: current.body,
        assertions: current.assertions as Prisma.InputJsonValue,
        headers: current.headers as Prisma.InputJsonValue,
        scheduleIntervalSec: current.scheduleIntervalSec,
        slackWebhookSecret: current.slackWebhookSecretId ? { connect: { id: current.slackWebhookSecretId } } : { disconnect: true },
      };
      await this.prisma.apiScenario.update({ where: { id: current.id }, data: restore });
      try {
        if (current.scheduleIntervalSec === null) await this.queue.removeSchedule(current.id);
        else await this.queue.schedule(current.id, current.scheduleIntervalSec);
      } catch { /* A later update can reconcile the scheduler. */ }
      throw new ServiceUnavailableException("The scenario schedule could not be updated. Please retry.");
    }
    return updated;
  }

  async remove(user: SessionUser, id: string) {
    this.requireWriteAccess(user);
    const scenario = await this.findOwned(user, id);
    try { await this.queue.removeSchedule(scenario.id); }
    catch { if (scenario.scheduleIntervalSec !== null) throw new ServiceUnavailableException("The scenario schedule could not be removed. Please retry."); }
    try { await this.prisma.apiScenario.delete({ where: { id: scenario.id } }); }
    catch (error) {
      if (scenario.scheduleIntervalSec !== null) {
        try { await this.queue.schedule(scenario.id, scenario.scheduleIntervalSec); } catch { /* A later update can reconcile the scheduler. */ }
      }
      throw error;
    }
    return { status: "deleted" };
  }

  async runNow(user: SessionUser, id: string) {
    this.requireWriteAccess(user);
    const scenario = await this.findOwned(user, id);
    const requestSnapshot = await this.buildRequestSnapshot(scenario);
    const run = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ApiScenario" WHERE "id" = ${scenario.id} FOR UPDATE`;
      const activeRun = await tx.apiScenarioRun.findFirst({
        where: { scenarioId: scenario.id, status: { in: ["QUEUED", "RUNNING"] } },
        select: { id: true },
      });
      if (activeRun) throw new BadRequestException("This scenario already has a run in progress.");
      return tx.apiScenarioRun.create({
        data: {
          scenarioId: scenario.id,
          requestSnapshot: requestSnapshot as Prisma.InputJsonValue,
          assertionsSnapshot: scenario.assertions as Prisma.InputJsonValue,
          trigger: "MANUAL",
        },
        select: { id: true, status: true, trigger: true, queuedAt: true },
      });
    });

    try {
      await this.queue.enqueue(run.id);
    } catch {
      await this.prisma.apiScenarioRun.updateMany({
        where: { id: run.id, status: "QUEUED" },
        data: { status: "ERROR", error: "A fila de execu\u00e7\u00e3o est\u00e1 indispon\u00edvel. Tente novamente.", completedAt: new Date() },
      });
      throw new ServiceUnavailableException("The API scenario queue is not available. Try again shortly.");
    }
    return run;
  }

  async runCollection(user: SessionUser, input: RunScenarioCollectionDto) {
    this.requireWriteAccess(user);
    const collectionName = input.collectionName.trim();
    const initial = await this.prisma.apiScenario.findMany({
      where: { organizationId: user.organizationId, collectionName },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!initial.length) throw new NotFoundException("This collection has no API scenarios to run.");
    if (initial.length > 100) throw new BadRequestException("A sequential run can include up to 100 scenarios.");
    const snapshots = await Promise.all(initial.map(async (scenario) => this.buildRequestSnapshot(scenario)));

    const runs = await this.prisma.$transaction(async (tx) => {
      for (const id of initial.map(({ id }) => id).sort()) {
        await tx.$queryRaw`SELECT "id" FROM "ApiScenario" WHERE "id" = ${id} FOR UPDATE`;
      }
      const current = await tx.apiScenario.findMany({
        where: { organizationId: user.organizationId, collectionName, id: { in: initial.map(({ id }) => id) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (current.length !== initial.length || current.some((scenario, index) => scenario.id !== initial[index].id || scenario.updatedAt.getTime() !== initial[index].updatedAt.getTime())) {
        throw new BadRequestException("The collection changed while it was being prepared. Try again.");
      }
      const activeRun = await tx.apiScenarioRun.findFirst({
        where: { scenarioId: { in: current.map(({ id }) => id) }, status: { in: ["QUEUED", "RUNNING"] } },
        select: { scenarioId: true },
      });
      if (activeRun) throw new BadRequestException("A scenario in this collection already has a run in progress.");

      const created: Prisma.ApiScenarioRunGetPayload<{ select: { id: true; scenarioId: true; status: true; trigger: true; queuedAt: true } }>[] = [];
      for (const [index, scenario] of current.entries()) {
        created.push(await tx.apiScenarioRun.create({
          data: {
            scenarioId: scenario.id,
            requestSnapshot: snapshots[index] as Prisma.InputJsonValue,
            assertionsSnapshot: scenario.assertions as Prisma.InputJsonValue,
            trigger: "COLLECTION",
          },
          select: { id: true, scenarioId: true, status: true, trigger: true, queuedAt: true },
        }));
      }
      return created;
    });

    try {
      await this.queue.enqueueSequence(runs.map(({ id }) => id));
    } catch {
      await this.prisma.apiScenarioRun.updateMany({
        where: { id: { in: runs.map(({ id }) => id) }, status: "QUEUED" },
        data: { status: "ERROR", error: "A fila de execução está indisponível. Tente novamente.", completedAt: new Date() },
      });
      throw new ServiceUnavailableException("The sequential scenario queue is not available. Try again shortly.");
    }
    return { collectionName, runs };
  }

  async history(user: SessionUser, id: string, limit = 20) {
    await this.findOwned(user, id);
    return this.prisma.apiScenarioRun.findMany({
      where: { scenario: { id, organizationId: user.organizationId } },
      select: {
        id: true,
        status: true,
        assertionResults: true,
        responseStatusCode: true,
        responseTimeMs: true,
        responsePreview: true,
        error: true,
        queuedAt: true,
        startedAt: true,
        completedAt: true,
        trigger: true,
      },
      orderBy: { queuedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 50),
    });
  }

  private async findOwned(user: SessionUser, id: string) {
    const scenario = await this.prisma.apiScenario.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { slackWebhookSecret: { select: { id: true, ciphertext: true, iv: true, authTag: true } } },
    });
    if (!scenario) throw new NotFoundException("API scenario not found.");
    return scenario;
  }

  private requireWriteAccess(user: SessionUser) {
    if (user.role === MembershipRole.VIEWER) throw new ForbiddenException("Your role cannot change API scenarios.");
  }

  private normalizeUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException("Enter a valid HTTP or HTTPS URL.");
    }
    if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password || !url.hostname) {
      throw new BadRequestException("Only credential-free HTTP and HTTPS URLs are supported.");
    }
    const expectedPort = url.protocol === "http:" ? "80" : "443";
    if (url.port && url.port !== expectedPort) throw new BadRequestException("Only standard HTTP and HTTPS ports are allowed.");
    url.hash = "";
    return url.toString();
  }

  private validateAssertions(assertions: CreateScenarioDto["assertions"]) {
    if (!Array.isArray(assertions) || assertions.length < 1 || assertions.length > 10) {
      throw new BadRequestException("Add between one and ten response checks.");
    }
    for (const assertion of assertions) {
      if (!Object.values(ScenarioAssertionType).includes(assertion.type as ScenarioAssertionType)) {
        throw new BadRequestException("Choose a supported response check.");
      }
      if (assertion.type === ScenarioAssertionType.STATUS_CODE) {
        const code = Number(assertion.expected);
        if (!Number.isInteger(code) || code < 100 || code > 599) throw new BadRequestException("Status code checks must be between 100 and 599.");
      } else if (assertion.type === ScenarioAssertionType.RESPONSE_TIME_MS) {
        const duration = Number(assertion.expected);
        if (!Number.isInteger(duration) || duration < 1 || duration > 10000) throw new BadRequestException("Response time checks must be between 1 and 10000 ms.");
      } else if (!assertion.expected.trim()) {
        throw new BadRequestException("Body checks need text to find in the response.");
      }
    }
  }

  private normalizeSchedule(intervalSec: number | null) {
    if (intervalSec === null) return null;
    if (![300, 900, 3600, 86400].includes(intervalSec)) throw new BadRequestException("Choose a schedule of 5 minutes, 15 minutes, 1 hour, or 24 hours.");
    return intervalSec;
  }

  private async normalizeHeaders(organizationId: string, inputs: HeaderInput[]) {
    if (inputs.length > 20) throw new BadRequestException("A scenario can send up to 20 headers.");
    const seen = new Set<string>();
    const normalized: HeaderInput[] = [];
    for (const item of inputs) {
      if (!item || typeof item.name !== "string") throw new BadRequestException("Each request header needs a valid name.");
      const name = item.name.trim();
      const key = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || forbiddenHeaders.has(key)) throw new BadRequestException(`The ${name || "request"} header cannot be sent by a scenario.`);
      if (seen.has(key)) throw new BadRequestException("Request header names must be unique.");
      seen.add(key);
      const prefix = item.prefix ?? "";
      if (/[\r\n]/.test(prefix) || prefix.length > 40) throw new BadRequestException("Header prefixes cannot contain line breaks.");
      if (item.secretId) {
        if (item.value !== undefined && item.value !== "") throw new BadRequestException("A secret header cannot also contain a plain value.");
        await this.secrets.encryptedForScenario(organizationId, item.secretId, ScenarioSecretType.API_CREDENTIAL);
        normalized.push({ name, secretId: item.secretId, ...(prefix ? { prefix } : {}) });
      } else {
        if (sensitiveHeaders.has(key) || /(^|[-_])(?:auth|token|secret|api[-_]?key)(?:$|[-_])/.test(key)) throw new BadRequestException(`${name} must use an encrypted credential from the vault.`);
        if (typeof item.value !== "string" || item.value.length > 2048 || /[\r\n]/.test(item.value)) throw new BadRequestException(`Enter a valid value for ${name}.`);
        if (prefix) throw new BadRequestException("A prefix can only be used with a vault credential.");
        normalized.push({ name, value: item.value });
      }
    }
    return normalized;
  }

  private async buildRequestSnapshot(scenario: {
    organizationId: string;
    method: ApiScenarioMethod;
    url: string;
    body: string | null;
    headers: Prisma.JsonValue;
    slackWebhookSecretId: string | null;
  }) {
    const storedHeaders = Array.isArray(scenario.headers) ? scenario.headers : [];
    const headers: Record<string, unknown>[] = [];
    for (const value of storedHeaders) {
      if (!isJsonRecord(value) || typeof value.name !== "string") continue;
      if (typeof value.secretId === "string") {
        const encrypted = await this.secrets.encryptedForScenario(scenario.organizationId, value.secretId, ScenarioSecretType.API_CREDENTIAL);
        headers.push({ name: value.name, encrypted: { ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag }, ...(typeof value.prefix === "string" ? { prefix: value.prefix } : {}) });
      } else if (typeof value.value === "string") headers.push({ name: value.name, value: value.value });
    }
    let slackWebhook: { ciphertext: string; iv: string; authTag: string } | null = null;
    if (scenario.slackWebhookSecretId) {
      const encrypted = await this.secrets.encryptedForScenario(scenario.organizationId, scenario.slackWebhookSecretId, ScenarioSecretType.SLACK_WEBHOOK);
      slackWebhook = { ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag };
    }
    return {
      method: scenario.method,
      url: scenario.url,
      body: scenario.body,
      headers,
      slackWebhook,
    };
  }
}

function isJsonRecord(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
