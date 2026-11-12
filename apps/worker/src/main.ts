import { config as loadEnv } from "dotenv";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { PrismaClient, IncidentSeverity, IncidentStatus, Prisma } from "@prisma/client";
import { createDecipheriv, createHash } from "node:crypto";
import { resolve } from "node:path";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { ClientRequest } from "node:http";
import { isPublicAddress, lookupPublicAddresses, parseHttpTarget, type SafeAddress } from "./target-security";

loadEnv({ path: resolve(process.cwd(), "../../.env") });

if (!/^[a-fA-F0-9]{64}$/.test(process.env.SCENARIO_SECRET_KEY ?? "")) {
  throw new Error("Set SCENARIO_SECRET_KEY to a private 32-byte hexadecimal key in the root .env file.");
}

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const emailConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const notificationPublisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
const notificationEmailQueue = new Queue<NotificationEmailPayload>("notification-emails", { connection: emailConnection });
const prisma = new PrismaClient();
const NOTIFICATION_CHANNEL = "nexus:notification-events";

type NotificationEmailPayload = { organizationId: string; sourceId: string; subject: string; text: string };
type MonitorNotificationAlert = NotificationEmailPayload;

function hasEmailDelivery() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

async function publishNotificationUpdate(organizationId: string) {
  try {
    await notificationPublisher.publish(NOTIFICATION_CHANNEL, JSON.stringify({ organizationId }));
  } catch {
    console.error(JSON.stringify({ event: "notification.realtime.publish_failed", organizationId }));
  }
}

async function enqueueNotificationEmail(alert: NotificationEmailPayload) {
  if (!hasEmailDelivery()) return;
  try {
    await notificationEmailQueue.add("send-notification-email", alert, {
      jobId: `nexus-${alert.sourceId}`,
      attempts: 4,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800 },
    });
  } catch {
    console.error(JSON.stringify({ event: "notification.email.enqueue_failed", sourceId: alert.sourceId }));
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | SafeAddress[], family?: number) => void;
type CheckOutcome = { success: boolean; statusCode: number | null; latencyMs: number; error: string | null };

const safeLookup = ((hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
  void lookupPublicAddresses(hostname).then((addresses) => {
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "DNS lookup failed.";
    const lookupError = Object.assign(new Error(message), { code: "EACCES" });
    callback(lookupError, "", 0);
  });
}) as unknown as LookupFunction;

async function checkTarget(value: string): Promise<CheckOutcome> {
  const startedAt = Date.now();
  let url: URL;
  try {
    url = parseHttpTarget(value);
    await lookupPublicAddresses(url.hostname);
  } catch (error) {
    return { success: false, statusCode: null, latencyMs: Date.now() - startedAt, error: safeMessage(error) };
  }

  return new Promise((resolveCheck) => {
    const agent = url.protocol === "https:"
      ? new HttpsAgent({ keepAlive: false, lookup: safeLookup })
      : new HttpAgent({ keepAlive: false, lookup: safeLookup });
    let settled = false;
    let totalTimeout: NodeJS.Timeout | undefined;
    const finish = (outcome: CheckOutcome) => {
      if (settled) return;
      settled = true;
      if (totalTimeout) clearTimeout(totalTimeout);
      agent.destroy();
      resolveCheck(outcome);
    };

    const onResponse = (response: import("node:http").IncomingMessage) => {
      const statusCode = response.statusCode ?? null;
      response.destroy();
      const success = statusCode !== null && statusCode >= 200 && statusCode < 300;
      finish({
        success,
        statusCode,
        latencyMs: Date.now() - startedAt,
        error: success ? null : statusCode && statusCode >= 300 && statusCode < 400 ? "Redirect responses are not followed." : `HTTP ${statusCode ?? "unknown"}`,
      });
    };

    const request: ClientRequest = url.protocol === "https:" ? httpsRequest(url, {
      method: "GET",
      agent,
      maxHeaderSize: 8192,
      headers: { "user-agent": "NEXUS-Monitor/0.1", accept: "*/*" },
    }, onResponse) : httpRequest(url, {
      method: "GET",
      agent,
      maxHeaderSize: 8192,
      headers: { "user-agent": "NEXUS-Monitor/0.1", accept: "*/*" },
    }, onResponse);

    totalTimeout = setTimeout(() => request.destroy(new Error("Request timed out.")), 8000);
    request.setTimeout(8000, () => request.destroy(new Error("Request timed out.")));
    request.once("error", (error) => finish({ success: false, statusCode: null, latencyMs: Date.now() - startedAt, error: safeMessage(error) }));
    request.end();
  });
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed.";
  return message.replace(/[\r\n\t]/g, " ").slice(0, 500);
}

async function notifyOrganizationMembers(tx: Prisma.TransactionClient, organizationId: string, eventId: string) {
  const memberships = await tx.membership.findMany({ where: { organizationId }, select: { userId: true } });
  if (!memberships.length) return;
  await tx.incidentNotification.createMany({
    data: memberships.map(({ userId }) => ({ userId, eventId })),
    skipDuplicates: true,
  });
}

function createMonitorNotificationAlert(organizationId: string, sourceId: string, monitorName: string, recovered: boolean, statusCode: number | null): MonitorNotificationAlert {
  const title = recovered ? "Serviço recuperado" : "Incidente aberto";
  const status = statusCode ? `HTTP ${statusCode}` : "sem resposta HTTP";
  return {
    organizationId,
    sourceId,
    subject: `NEXUS · ${title}: ${monitorName.replace(/[\r\n]/g, " ").slice(0, 100)}`,
    text: `NEXUS · ${title}\nServiço: ${monitorName.replace(/[\r\n]/g, " ")}\nResposta: ${status}\n\nConsulte a inbox do NEXUS para ver os detalhes.`,
  };
}

async function processMonitorCheck(monitorId: string, queueJobId: string) {
  const priorCheck = await prisma.monitorCheck.findUnique({ where: { queueJobId }, select: { id: true } });
  if (priorCheck) return { duplicate: true };

  const monitor = await prisma.monitor.findUnique({ where: { id: monitorId } });
  if (!monitor || !monitor.isActive) return { skipped: true };

  const outcome = await checkTarget(monitor.url);
  const persisted = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Monitor" WHERE "id" = ${monitor.id} FOR UPDATE`;
    const alreadySaved = await tx.monitorCheck.findUnique({ where: { queueJobId }, select: { id: true } });
    if (alreadySaved) return { saved: false, alerts: [] as MonitorNotificationAlert[] };
    const alerts: MonitorNotificationAlert[] = [];

    await tx.monitorCheck.create({
      data: {
        monitorId: monitor.id,
        queueJobId,
        success: outcome.success,
        statusCode: outcome.statusCode,
        latencyMs: outcome.latencyMs,
        error: outcome.error,
      },
    });

    if (outcome.success) {
      const openIncidents = await tx.incident.findMany({
        where: { monitorId: monitor.id, status: IncidentStatus.OPEN },
        select: { id: true },
      });
      if (openIncidents.length) {
        const resolvedAt = new Date();
        await tx.incident.updateMany({
          where: { id: { in: openIncidents.map(({ id }) => id) }, status: IncidentStatus.OPEN },
          data: { status: IncidentStatus.RESOLVED, resolvedAt },
        });
        for (const incident of openIncidents) {
          const event = await tx.incidentEvent.create({
            data: {
              incidentId: incident.id,
              type: "RESOLVED",
              message: "A successful health check confirmed service recovery.",
              createdAt: resolvedAt,
            },
            select: { id: true },
          });
          await notifyOrganizationMembers(tx, monitor.organizationId, event.id);
          alerts.push(createMonitorNotificationAlert(monitor.organizationId, event.id, monitor.name, true, outcome.statusCode));
        }
      }
      return { saved: true, alerts };
    }

    const openIncident = await tx.incident.findFirst({ where: { monitorId: monitor.id, status: IncidentStatus.OPEN }, select: { id: true } });
    if (!openIncident) {
      const severity = outcome.statusCode && outcome.statusCode >= 500 ? IncidentSeverity.HIGH : IncidentSeverity.MEDIUM;
      const incident = await tx.incident.create({
        data: {
          organizationId: monitor.organizationId,
          monitorId: monitor.id,
          severity,
          title: "Service health check failed",
          message: outcome.error ?? `HTTP ${outcome.statusCode ?? "unknown"}`,
        },
        select: { id: true },
      });
      const event = await tx.incidentEvent.create({
        data: {
          incidentId: incident.id,
          type: "OPENED",
          message: outcome.error ?? `HTTP ${outcome.statusCode ?? "unknown"}`,
        },
        select: { id: true },
      });
      await notifyOrganizationMembers(tx, monitor.organizationId, event.id);
      alerts.push(createMonitorNotificationAlert(monitor.organizationId, event.id, monitor.name, false, outcome.statusCode));
    }
    return { saved: true, alerts };
  });

  if (!persisted.saved) return { duplicate: true };

  for (const alert of persisted.alerts) {
    await publishNotificationUpdate(alert.organizationId);
    await enqueueNotificationEmail(alert);
  }

  console.info(JSON.stringify({ event: "monitor.check.saved", monitorId, success: outcome.success, statusCode: outcome.statusCode, latencyMs: outcome.latencyMs }));
  return outcome;
}

type EncryptedSecret = { ciphertext: string; iv: string; authTag: string };
type ScenarioHeaderSnapshot = { name: string; value?: string; encrypted?: EncryptedSecret; prefix?: string };
type ScenarioRequestSnapshot = { method: string; url: string; body: string | null; headers: ScenarioHeaderSnapshot[]; slackWebhook: EncryptedSecret | null };
type ScenarioAssertionSnapshot = { type: "STATUS_CODE" | "BODY_CONTAINS" | "RESPONSE_TIME_MS"; expected: string };
type ScenarioHttpOutcome = { statusCode: number; responseTimeMs: number; body: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readScenarioRequest(value: Prisma.JsonValue): ScenarioRequestSnapshot {
  if (!isRecord(value) || typeof value.method !== "string" || typeof value.url !== "string" || !(typeof value.body === "string" || value.body === null)) {
    throw new Error("The saved request is invalid.");
  }
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(value.method)) throw new Error("The saved request method is invalid.");
  const headers = Array.isArray(value.headers) ? value.headers.map((item): ScenarioHeaderSnapshot => {
    if (!isRecord(item) || typeof item.name !== "string") throw new Error("A saved request header is invalid.");
    const header: ScenarioHeaderSnapshot = { name: item.name };
    if (typeof item.value === "string") header.value = item.value;
    if (isRecord(item.encrypted) && typeof item.encrypted.ciphertext === "string" && typeof item.encrypted.iv === "string" && typeof item.encrypted.authTag === "string") {
      header.encrypted = { ciphertext: item.encrypted.ciphertext, iv: item.encrypted.iv, authTag: item.encrypted.authTag };
    }
    if (typeof item.prefix === "string") header.prefix = item.prefix;
    if ((header.value === undefined) === (header.encrypted === undefined)) throw new Error("A saved request header needs one valid value.");
    return header;
  }) : [];
  if (headers.length > 20) throw new Error("The saved request has too many headers.");
  let slackWebhook: EncryptedSecret | null = null;
  if (value.slackWebhook !== null && value.slackWebhook !== undefined) {
    if (!isRecord(value.slackWebhook) || typeof value.slackWebhook.ciphertext !== "string" || typeof value.slackWebhook.iv !== "string" || typeof value.slackWebhook.authTag !== "string") {
      throw new Error("The saved Slack destination is invalid.");
    }
    slackWebhook = { ciphertext: value.slackWebhook.ciphertext, iv: value.slackWebhook.iv, authTag: value.slackWebhook.authTag };
  }
  return { method: value.method, url: value.url, body: value.body, headers, slackWebhook };
}

function decryptScenarioSecret(value: EncryptedSecret): string {
  const configured = process.env.SCENARIO_SECRET_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(configured)) throw new Error("SCENARIO_SECRET_KEY is missing or invalid.");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(configured, "hex"), Buffer.from(value.iv, "hex"));
  decipher.setAuthTag(Buffer.from(value.authTag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

async function resolveScenarioHeaders(snapshot: ScenarioRequestSnapshot) {
  const headers: Record<string, string> = {
    "user-agent": "NEXUS-API-Scenario/0.2",
    accept: "*/*",
    "accept-encoding": "identity",
  };
  if (snapshot.body !== null) headers["content-type"] = "application/json";
  const seen = new Set<string>();
  const secretValues: string[] = [];
  const forbidden = new Set(["host", "cookie", "set-cookie", "content-length", "connection", "transfer-encoding", "proxy-connection", "keep-alive", "upgrade", "te", "trailer", "expect", "accept-encoding"]);
  for (const header of snapshot.headers) {
    const key = header.name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name) || forbidden.has(key) || seen.has(key)) throw new Error("A saved request header is not allowed.");
    seen.add(key);
    let value = header.value ?? "";
    if (header.encrypted) {
      const secret = decryptScenarioSecret(header.encrypted);
      secretValues.push(secret);
      value = `${header.prefix ?? ""}${secret}`;
    }
    if (value.length > 8192 || /[\r\n]/.test(value)) throw new Error("A saved request header value is invalid.");
    headers[key] = value;
  }
  return { headers, secretValues };
}

function readScenarioAssertions(value: Prisma.JsonValue): ScenarioAssertionSnapshot[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new Error("The saved response checks are invalid.");
  return value.map((item) => {
    if (!isRecord(item) || typeof item.expected !== "string" || !["STATUS_CODE", "BODY_CONTAINS", "RESPONSE_TIME_MS"].includes(String(item.type))) {
      throw new Error("A saved response check is invalid.");
    }
    return { type: item.type as ScenarioAssertionSnapshot["type"], expected: item.expected };
  });
}

async function requestScenarioTarget(snapshot: ScenarioRequestSnapshot, headers: Record<string, string>): Promise<ScenarioHttpOutcome> {
  const startedAt = Date.now();
  let url: URL;
  try {
    url = parseHttpTarget(snapshot.url);
    await lookupPublicAddresses(url.hostname);
  } catch (error) {
    throw new Error(safeMessage(error));
  }

  return new Promise((resolveRequest, rejectRequest) => {
    const agent = url.protocol === "https:"
      ? new HttpsAgent({ keepAlive: false, lookup: safeLookup })
      : new HttpAgent({ keepAlive: false, lookup: safeLookup });
    let settled = false;
    let totalTimeout: NodeJS.Timeout | undefined;
    const finish = (error?: Error, outcome?: ScenarioHttpOutcome) => {
      if (settled) return;
      settled = true;
      if (totalTimeout) clearTimeout(totalTimeout);
      agent.destroy();
      if (error) rejectRequest(error);
      else if (outcome) resolveRequest(outcome);
      else rejectRequest(new Error("The target returned an empty response."));
    };

    const onResponse = (response: import("node:http").IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 1_048_576) {
          response.destroy();
          finish(new Error("The response exceeded the 1 MB limit."));
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", (error) => finish(error));
      response.once("aborted", () => finish(new Error("The response ended before it was complete.")));
      response.once("end", () => finish(undefined, {
        statusCode: response.statusCode ?? 0,
        responseTimeMs: Date.now() - startedAt,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    };

    const requestOptions = {
      method: snapshot.method,
      agent,
      maxHeaderSize: 8192,
      headers,
    };
    const request = url.protocol === "https:"
      ? httpsRequest(url, requestOptions, onResponse)
      : httpRequest(url, requestOptions, onResponse);
    totalTimeout = setTimeout(() => request.destroy(new Error("Request timed out.")), 10_000);
    request.setTimeout(10_000, () => request.destroy(new Error("Request timed out.")));
    request.once("error", (error) => finish(error));
    if (snapshot.body !== null) request.write(snapshot.body);
    request.end();
  });
}

function evaluateScenarioAssertions(assertions: ScenarioAssertionSnapshot[], response: ScenarioHttpOutcome) {
  return assertions.map((assertion) => {
    let passed = false;
    let actual = "";
    if (assertion.type === "STATUS_CODE") {
      actual = String(response.statusCode);
      passed = response.statusCode === Number(assertion.expected);
    } else if (assertion.type === "RESPONSE_TIME_MS") {
      actual = String(response.responseTimeMs);
      passed = response.responseTimeMs <= Number(assertion.expected);
    } else {
      actual = response.body.includes(assertion.expected) ? "Texto encontrado" : "Texto ausente";
      passed = response.body.includes(assertion.expected);
    }
    return { type: assertion.type, expected: assertion.expected, actual, passed };
  });
}

type ScenarioRunFinalStatus = "PASSED" | "FAILED" | "ERROR";
type ScenarioCompletion = {
  responseStatusCode: number | null;
  responseTimeMs: number;
  responsePreview?: string | null;
  assertionResults?: ReturnType<typeof evaluateScenarioAssertions>;
  error?: string | null;
};
type ScenarioAlert = {
  organizationId: string;
  runId: string;
  scenarioName: string;
  method: string;
  status: ScenarioRunFinalStatus;
  responseStatusCode: number | null;
  responseTimeMs: number;
  slackWebhook: EncryptedSecret | null;
};

function redactSecrets(value: string, secrets: string[]) {
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
}

async function persistScenarioCompletion(runId: string, status: ScenarioRunFinalStatus, result: ScenarioCompletion): Promise<ScenarioAlert | null> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.apiScenarioRun.findUnique({
      where: { id: runId },
      include: { scenario: { select: { name: true, method: true, organizationId: true } } },
    });
    if (!run || run.status !== "RUNNING") return null;
    const previous = await tx.apiScenarioRun.findFirst({
      where: { scenarioId: run.scenarioId, queuedAt: { lt: run.queuedAt }, status: { in: ["PASSED", "FAILED", "ERROR"] } },
      orderBy: { queuedAt: "desc" },
      select: { status: true },
    });
    const wasFailing = previous?.status === "FAILED" || previous?.status === "ERROR";
    const isFailing = status === "FAILED" || status === "ERROR";
    await tx.apiScenarioRun.update({
      where: { id: run.id },
      data: {
        status,
        responseStatusCode: result.responseStatusCode,
        responseTimeMs: result.responseTimeMs,
        responsePreview: result.responsePreview ?? null,
        assertionResults: result.assertionResults ? result.assertionResults as Prisma.InputJsonValue : Prisma.JsonNull,
        error: result.error ?? null,
        completedAt: new Date(),
      },
    });
    if (wasFailing === isFailing) return null;

    const memberships = await tx.membership.findMany({
      where: { organizationId: run.scenario.organizationId },
      select: { userId: true },
    });
    if (memberships.length) {
      await tx.apiScenarioNotification.createMany({
        data: memberships.map(({ userId }) => ({ userId, scenarioId: run.scenarioId, runId: run.id })),
        skipDuplicates: true,
      });
    }
    let slackWebhook: EncryptedSecret | null = null;
    try { slackWebhook = readScenarioRequest(run.requestSnapshot).slackWebhook; } catch { /* The run result still needs to be persisted if an old snapshot is malformed. */ }
    return {
      organizationId: run.scenario.organizationId,
      runId: run.id,
      scenarioName: run.scenario.name,
      method: run.scenario.method,
      status,
      responseStatusCode: result.responseStatusCode,
      responseTimeMs: result.responseTimeMs,
      slackWebhook,
    };
  });
}

async function sendScenarioSlackAlert(alert: ScenarioAlert) {
  if (!alert.slackWebhook) return;
  const value = decryptScenarioSecret(alert.slackWebhook);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || url.port || url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/services/")) {
    throw new Error("The saved Slack destination is invalid.");
  }
  await lookupPublicAddresses(url.hostname);
  const isRecovery = alert.status === "PASSED";
  const title = isRecovery ? "CENÁRIO RECUPERADO" : "FALHA NO CENÁRIO";
  const body = Buffer.from(JSON.stringify({
    text: `NEXUS · ${title}\nCenário: ${alert.scenarioName.replace(/[\r\n]/g, " ")}\nRequisição: ${alert.method} · ${alert.responseStatusCode ? `HTTP ${alert.responseStatusCode}` : "sem resposta HTTP"}\nTempo: ${alert.responseTimeMs} ms`,
    mrkdwn: false,
  }));
  await new Promise<void>((resolveSend, rejectSend) => {
    const agent = new HttpsAgent({ keepAlive: false, lookup: safeLookup });
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      agent.destroy();
      if (error) rejectSend(error);
      else resolveSend();
    };
    const request = httpsRequest(url, {
      method: "POST",
      agent,
      maxHeaderSize: 4096,
      headers: { "content-type": "application/json", "content-length": String(body.length), "user-agent": "NEXUS-Scenario-Alerts/0.1" },
    }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 200 ? finish() : finish(new Error("Slack did not accept the alert.")));
      response.once("error", () => finish(new Error("Slack alert delivery failed.")));
    });
    timeout = setTimeout(() => request.destroy(new Error("Slack alert timed out.")), 8000);
    request.setTimeout(8000, () => request.destroy(new Error("Slack alert timed out.")));
    request.once("error", () => finish(new Error("Slack alert delivery failed.")));
    request.end(body);
  });
}

async function dispatchScenarioAlert(alert: ScenarioAlert | null) {
  if (!alert) return;
  const isRecovery = alert.status === "PASSED";
  const title = isRecovery ? "Cenário recuperado" : "Falha no cenário";
  const scenarioName = alert.scenarioName.replace(/[\r\n]/g, " ");
  const response = alert.responseStatusCode ? `HTTP ${alert.responseStatusCode}` : "sem resposta HTTP";
  await publishNotificationUpdate(alert.organizationId);
  await enqueueNotificationEmail({
    organizationId: alert.organizationId,
    sourceId: alert.runId,
    subject: `NEXUS · ${title}: ${scenarioName.slice(0, 100)}`,
    text: `NEXUS · ${title}\nCenário: ${scenarioName}\nRequisição: ${alert.method} · ${response}\nTempo: ${alert.responseTimeMs} ms\n\nConsulte a inbox do NEXUS para ver os detalhes.`,
  });
  try {
    await sendScenarioSlackAlert(alert);
    if (alert.slackWebhook) console.info(JSON.stringify({ event: "scenario.alert.sent", runId: alert.runId, status: alert.status }));
  } catch {
    console.error(JSON.stringify({ event: "scenario.alert.delivery_failed", runId: alert.runId, status: alert.status }));
  }
}

async function deliverNotificationEmail(alert: NotificationEmailPayload) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) return { skipped: true };

  const memberships = await prisma.membership.findMany({
    where: { organizationId: alert.organizationId, user: { is: { emailAlertsEnabled: true } } },
    select: { user: { select: { email: true } } },
  });
  const recipients = [...new Set(memberships.map(({ user }) => user.email))];
  if (!recipients.length) return { skipped: true };

  for (let index = 0; index < recipients.length; index += 5) {
    const batch = recipients.slice(index, index + 5);
    await Promise.all(batch.map(async (email) => {
      const recipientKey = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 24);
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": `nexus/${alert.sourceId}/${recipientKey}`,
        },
        body: JSON.stringify({ from, to: [email], subject: alert.subject.replace(/[\r\n]/g, " ").slice(0, 180), text: alert.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Email provider rejected alert delivery.");
    }));
  }

  console.info(JSON.stringify({ event: "notification.email.sent", sourceId: alert.sourceId, recipientCount: recipients.length }));
  return { sent: recipients.length };
}

type StoredScenario = {
  id: string;
  organizationId: string;
  method: string;
  url: string;
  body: string | null;
  assertions: Prisma.JsonValue;
  headers: Prisma.JsonValue;
  scheduleIntervalSec: number | null;
  slackWebhookSecretId: string | null;
};

async function buildScenarioRequestSnapshot(client: Pick<Prisma.TransactionClient, "scenarioSecret">, scenario: StoredScenario) {
  if (!Array.isArray(scenario.headers)) throw new Error("The saved request headers are invalid.");
  const headers: ScenarioHeaderSnapshot[] = [];
  for (const item of scenario.headers) {
    if (!isRecord(item) || typeof item.name !== "string") throw new Error("A saved request header is invalid.");
    if (typeof item.secretId === "string") {
      const secret = await client.scenarioSecret.findFirst({
        where: { id: item.secretId, organizationId: scenario.organizationId, type: "API_CREDENTIAL" },
        select: { ciphertext: true, iv: true, authTag: true },
      });
      if (!secret) throw new Error("A saved request credential is no longer available.");
      headers.push({ name: item.name, encrypted: secret, ...(typeof item.prefix === "string" ? { prefix: item.prefix } : {}) });
    } else if (typeof item.value === "string") headers.push({ name: item.name, value: item.value });
    else throw new Error("A saved request header is invalid.");
  }
  let slackWebhook: EncryptedSecret | null = null;
  if (scenario.slackWebhookSecretId) {
    const secret = await client.scenarioSecret.findFirst({
      where: { id: scenario.slackWebhookSecretId, organizationId: scenario.organizationId, type: "SLACK_WEBHOOK" },
      select: { ciphertext: true, iv: true, authTag: true },
    });
    if (!secret) throw new Error("The saved Slack destination is no longer available.");
    slackWebhook = secret;
  }
  return { method: scenario.method, url: scenario.url, body: scenario.body, headers, slackWebhook } satisfies ScenarioRequestSnapshot;
}

async function queueScheduledScenarioRun(scenarioId: string, queueJobId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.apiScenarioRun.findUnique({ where: { queueJobId }, select: { id: true } });
    if (existing) return existing.id;
    await tx.$queryRaw`SELECT "id" FROM "ApiScenario" WHERE "id" = ${scenarioId} FOR UPDATE`;
    const scenario = await tx.apiScenario.findUnique({ where: { id: scenarioId } });
    if (!scenario || scenario.scheduleIntervalSec === null) return null;
    const duplicate = await tx.apiScenarioRun.findUnique({ where: { queueJobId }, select: { id: true } });
    if (duplicate) return duplicate.id;
    const activeRun = await tx.apiScenarioRun.findFirst({
      where: { scenarioId, status: { in: ["QUEUED", "RUNNING"] } },
      select: { id: true },
    });
    if (activeRun) return null;
    const requestSnapshot = await buildScenarioRequestSnapshot(tx, scenario);
    const run = await tx.apiScenarioRun.create({
      data: {
        scenarioId,
        queueJobId,
        trigger: "SCHEDULED",
        requestSnapshot: requestSnapshot as unknown as Prisma.InputJsonValue,
        assertionsSnapshot: scenario.assertions as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return run.id;
  });
}

async function processApiScenarioRun(runId: string) {
  const run = await prisma.apiScenarioRun.findUnique({ where: { id: runId } });
  if (!run || ["PASSED", "FAILED", "ERROR"].includes(run.status)) return { skipped: true };
  const startedAt = run.startedAt ?? new Date();
  const claimed = await prisma.apiScenarioRun.updateMany({
    where: { id: run.id, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "RUNNING", startedAt },
  });
  if (!claimed.count) return { skipped: true };
  let secretValues: string[] = [];

  try {
    const request = readScenarioRequest(run.requestSnapshot);
    const assertions = readScenarioAssertions(run.assertionsSnapshot);
    const resolvedHeaders = await resolveScenarioHeaders(request);
    secretValues = resolvedHeaders.secretValues;
    const response = await requestScenarioTarget(request, resolvedHeaders.headers);
    const assertionResults = evaluateScenarioAssertions(assertions, response);
    const passed = assertionResults.every((result) => result.passed);
    const status = passed ? "PASSED" : "FAILED";
    const alert = await persistScenarioCompletion(run.id, status, {
      responseStatusCode: response.statusCode || null,
      responseTimeMs: response.responseTimeMs,
      responsePreview: redactSecrets(response.body, secretValues).slice(0, 4000),
      assertionResults,
      error: null,
    });
    await dispatchScenarioAlert(alert);
    return { status };
  } catch (error) {
    const alert = await persistScenarioCompletion(run.id, "ERROR", {
      responseStatusCode: null,
      responseTimeMs: Date.now() - startedAt.getTime(),
      responsePreview: null,
      error: redactSecrets(safeMessage(error), secretValues).slice(0, 1000),
    });
    await dispatchScenarioAlert(alert);
    return { status: "ERROR" };
  }
}

async function processApiScenarioSequence(runIds: string[]) {
  const results: { runId: string; status: string }[] = [];
  for (const runId of runIds) {
    try {
      const result = await processApiScenarioRun(runId);
      results.push({ runId, status: typeof result?.status === "string" ? result.status : "SKIPPED" });
    } catch (error) {
      const message = safeMessage(error).slice(0, 1000);
      await prisma.apiScenarioRun.updateMany({
        where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "ERROR", error: message, completedAt: new Date() },
      });
      results.push({ runId, status: "ERROR" });
    }
  }
  return { status: "SEQUENCE_COMPLETE", results };
}

const worker = new Worker(
  "monitor-checks",
  async (job) => {
    if (job.name !== "monitor-check" || typeof job.data.monitorId !== "string") {
      throw new Error("Unsupported monitoring job payload.");
    }
    if (!job.id) throw new Error("Monitoring jobs require an id for idempotent processing.");
    return processMonitorCheck(job.data.monitorId, job.id);
  },
  { connection, concurrency: 10, limiter: { max: 1200, duration: 60_000 } },
);

worker.on("completed", (job) => console.info(JSON.stringify({ event: "job.completed", jobId: job.id })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "job.failed", jobId: job?.id, message: error.message })));
worker.on("error", (error) => console.error(JSON.stringify({ event: "worker.error", message: error.message })));

const scenarioConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const scenarioWorker = new Worker(
  "api-scenario-runs",
  async (job) => {
    if (job.name === "api-scenario-run" && typeof job.data.runId === "string") {
      return processApiScenarioRun(job.data.runId);
    }
    if (job.name === "api-scenario-sequence" && Array.isArray(job.data.runIds) && job.data.runIds.every((runId: unknown) => typeof runId === "string")) {
      return processApiScenarioSequence(job.data.runIds as string[]);
    }
    if (job.name === "api-scenario-scheduled" && typeof job.data.scenarioId === "string" && typeof job.id === "string") {
      const runId = await queueScheduledScenarioRun(job.data.scenarioId, job.id);
      return runId ? processApiScenarioRun(runId) : { skipped: true };
    }
    throw new Error("Unsupported API scenario job payload.");
  },
  { connection: scenarioConnection, concurrency: 4, limiter: { max: 60, duration: 60_000 } },
);

scenarioWorker.on("completed", (job, result) => console.info(JSON.stringify({ event: "scenario.completed", runId: job.data.runId, scenarioId: job.data.scenarioId, sequenceSize: job.data.runIds?.length, status: result.status ?? "SKIPPED" })));
scenarioWorker.on("failed", (job, error) => {
  if (typeof job?.data.runId === "string") {
    void prisma.apiScenarioRun.updateMany({
      where: { id: job.data.runId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "ERROR", error: safeMessage(error).slice(0, 1000), completedAt: new Date() },
    }).catch((persistError: unknown) => console.error(JSON.stringify({ event: "scenario.result.persist_failed", runId: job.data.runId, message: safeMessage(persistError) })));
  } else if (job?.name === "api-scenario-scheduled" && typeof job.id === "string") {
    void prisma.apiScenarioRun.updateMany({
      where: { queueJobId: job.id, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "ERROR", error: "A execução agendada não foi concluída. Consulte os logs do worker.", completedAt: new Date() },
    }).catch(() => console.error(JSON.stringify({ event: "scenario.result.persist_failed", queueJobId: job.id })));
  } else if (job?.name === "api-scenario-sequence" && Array.isArray(job.data.runIds)) {
    const runIds = job.data.runIds.filter((runId: unknown): runId is string => typeof runId === "string");
    void prisma.apiScenarioRun.updateMany({
      where: { id: { in: runIds }, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "ERROR", error: "A sequência de cenários não foi concluída. Consulte os logs do worker.", completedAt: new Date() },
    }).catch(() => console.error(JSON.stringify({ event: "scenario.sequence.persist_failed", sequenceSize: runIds.length })));
  }
  console.error(JSON.stringify({ event: "scenario.failed", runId: job?.data.runId, message: error.message }));
});
scenarioWorker.on("error", (error) => console.error(JSON.stringify({ event: "scenario.worker.error", message: error.message })));

const notificationEmailWorker = new Worker<NotificationEmailPayload>(
  "notification-emails",
  async (job) => {
    if (job.name !== "send-notification-email") throw new Error("Unsupported notification email job.");
    return deliverNotificationEmail(job.data);
  },
  { connection: emailConnection, concurrency: 3 },
);

notificationEmailWorker.on("completed", (job, result) => console.info(JSON.stringify({ event: "notification.email.completed", sourceId: job.data.sourceId, sent: result.sent ?? 0 })));
notificationEmailWorker.on("failed", (job) => console.error(JSON.stringify({ event: "notification.email.failed", sourceId: job?.data.sourceId })));
notificationEmailWorker.on("error", () => console.error(JSON.stringify({ event: "notification.email.worker_error" })));

async function shutdown() {
  await Promise.all([worker.close(), scenarioWorker.close(), notificationEmailWorker.close(), notificationEmailQueue.close()]);
  await Promise.all([connection.quit(), scenarioConnection.quit(), emailConnection.quit(), notificationPublisher.quit()]);
  await prisma.$disconnect();
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
