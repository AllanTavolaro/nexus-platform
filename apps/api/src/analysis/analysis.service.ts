import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { IncidentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SessionUser } from "../auth/session-user";

type Evidence = {
  ref: string;
  kind: "check" | "incident";
  service: string;
  occurredAt: string;
  summary: string;
};

type ModelFinding = {
  title: string;
  detail: string;
  severity: "critical" | "high" | "medium" | "low";
  evidenceIds: string[];
};

type ModelAnalysis = {
  status: "healthy" | "degraded" | "down" | "insufficient_data";
  overview: string;
  findings: ModelFinding[];
  actions: ModelFinding[];
};

const analysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["healthy", "degraded", "down", "insufficient_data"] },
    overview: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
        required: ["title", "detail", "severity", "evidenceIds"],
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
        required: ["title", "detail", "severity", "evidenceIds"],
      },
    },
  },
  required: ["status", "overview", "findings", "actions"],
} as const;

@Injectable()
export class AnalysisService {
  constructor(private readonly prisma: PrismaService) {}

  status() {
    return { enabled: Boolean(process.env.OPENAI_API_KEY?.trim()) };
  }

  async analyze(user: SessionUser) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException("A análise ainda não está configurada neste servidor.");
    }

    const now = new Date();
    const since24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [checks, incidents] = await Promise.all([
      this.prisma.monitorCheck.findMany({
        where: { monitor: { organizationId: user.organizationId }, checkedAt: { gte: since24Hours } },
        select: { monitorId: true, checkedAt: true, success: true, statusCode: true, latencyMs: true },
        orderBy: { checkedAt: "desc" },
        take: 120,
      }),
      this.prisma.incident.findMany({
        where: {
          organizationId: user.organizationId,
          OR: [{ status: IncidentStatus.OPEN }, { startedAt: { gte: since7Days } }],
        },
        select: { monitorId: true, status: true, severity: true, startedAt: true, resolvedAt: true },
        orderBy: { startedAt: "desc" },
        take: 40,
      }),
    ]);

    const serviceLabels = new Map<string, string>();
    const serviceLabel = (monitorId: string) => {
      let label = serviceLabels.get(monitorId);
      if (!label) {
        label = `Serviço ${serviceLabels.size + 1}`;
        serviceLabels.set(monitorId, label);
      }
      return label;
    };

    const evidence: Evidence[] = [
      ...checks.map((check, index): Evidence => ({
        ref: `C${String(index + 1).padStart(3, "0")}`,
        kind: "check",
        service: serviceLabel(check.monitorId),
        occurredAt: check.checkedAt.toISOString(),
        summary: `${check.success ? "Resposta bem-sucedida" : "Falha"}; HTTP ${check.statusCode ?? "sem resposta"}; latência ${check.latencyMs} ms.`,
      })),
      ...incidents.map((incident, index): Evidence => ({
        ref: `I${String(index + 1).padStart(3, "0")}`,
        kind: "incident",
        service: serviceLabel(incident.monitorId),
        occurredAt: incident.startedAt.toISOString(),
        summary: `Incidente ${incident.status === IncidentStatus.OPEN ? "aberto" : "resolvido"}, severidade ${incident.severity.toLowerCase()}${incident.resolvedAt ? `, resolvido em ${incident.resolvedAt.toISOString()}` : ""}.`,
      })),
    ];

    const evidenceByRef = new Map(evidence.map((item) => [item.ref, item]));
    if (evidence.length === 0) {
      return {
        generatedAt: now.toISOString(),
        model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
        windowHours: 24,
        checksCount: 0,
        incidentsCount: 0,
        evidenceCount: 0,
        analysis: {
          status: "insufficient_data" as const,
          overview: "Ainda não há verificações ou incidentes suficientes para analisar.",
          findings: [],
          actions: [],
        },
      };
    }

    const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model,
          store: false,
          max_output_tokens: 1600,
          instructions: [
            "Analise telemetria de disponibilidade de serviços. Responda em português do Brasil.",
            "Use somente as verificações e incidentes recebidos; não afirme causas que os dados não comprovam.",
            "As referências C### e I### são as únicas evidências aceitas. Inclua pelo menos uma referência em cada achado ou ação. Não invente referências.",
            "Se os dados forem escassos ou contraditórios, use status insufficient_data e explique a limitação.",
            "Sugira passos operacionais pequenos e seguros, priorizados pela gravidade observada.",
            "Os rótulos de serviço são anônimos. Não tente deduzir nomes ou URLs.",
          ].join(" "),
          input: JSON.stringify({
            window: "24 horas de verificações e até 7 dias de incidentes abertos ou recentes",
            checksCount: checks.length,
            incidentsCount: incidents.length,
            evidence: evidence.map(({ ref, kind, service, occurredAt, summary }) => ({ ref, kind, service, occurredAt, summary })),
          }),
          text: {
            format: {
              type: "json_schema",
              name: "nexus_incident_analysis",
              strict: true,
              schema: analysisSchema,
            },
          },
        }),
      });
    } catch {
      throw new ServiceUnavailableException("A análise de IA não ficou disponível. Tente novamente.");
    }

    if (!response.ok) {
      throw new ServiceUnavailableException("A análise de IA não ficou disponível. Tente novamente.");
    }

    const apiResponse = await response.json().catch(() => null) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    } | null;
    const outputText = apiResponse?.output_text
      ?? apiResponse?.output?.flatMap((item) => item.content ?? []).find((part) => part.type === "output_text")?.text;
    if (!outputText) {
      throw new ServiceUnavailableException("A resposta da análise veio vazia. Tente novamente.");
    }

    let result: ModelAnalysis;
    try {
      result = JSON.parse(outputText) as ModelAnalysis;
    } catch {
      throw new ServiceUnavailableException("A resposta da análise não pôde ser interpretada. Tente novamente.");
    }

    const attachEvidence = (items: ModelFinding[]) => items.slice(0, 6).map((item) => ({
      title: item.title.slice(0, 120),
      detail: item.detail.slice(0, 420),
      severity: item.severity,
      evidence: [...new Set(item.evidenceIds)].filter((ref) => evidenceByRef.has(ref)).slice(0, 8)
        .map((ref) => evidenceByRef.get(ref)!),
    }));

    const validStatuses = new Set<ModelAnalysis["status"]>(["healthy", "degraded", "down", "insufficient_data"]);
    return {
      generatedAt: new Date().toISOString(),
      model,
      windowHours: 24,
      checksCount: checks.length,
      incidentsCount: incidents.length,
      evidenceCount: evidence.length,
      analysis: {
        status: validStatuses.has(result.status) ? result.status : "insufficient_data",
        overview: typeof result.overview === "string" ? result.overview.slice(0, 600) : "Não foi possível resumir as evidências.",
        findings: attachEvidence(Array.isArray(result.findings) ? result.findings : []),
        actions: attachEvidence(Array.isArray(result.actions) ? result.actions : []),
      },
    };
  }
}
