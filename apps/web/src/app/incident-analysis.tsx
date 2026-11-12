"use client";

import { useEffect, useState } from "react";

type EvidenceReference = {
  ref: string;
  kind: "check" | "incident";
  service: string;
  occurredAt: string;
  summary: string;
};

type AnalysisItem = {
  title: string;
  detail: string;
  severity: "critical" | "high" | "medium" | "low";
  evidence: EvidenceReference[];
};

type IncidentAnalysisResult = {
  generatedAt: string;
  windowHours: number;
  checksCount: number;
  incidentsCount: number;
  evidenceCount: number;
  analysis: {
    status: "healthy" | "degraded" | "down" | "insufficient_data";
    overview: string;
    findings: AnalysisItem[];
    actions: AnalysisItem[];
  };
};

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api").replace(/\/$/, "");

const analysisStatusLabel: Record<IncidentAnalysisResult["analysis"]["status"], string> = {
  healthy: "Estável",
  degraded: "Atenção",
  down: "Indisponível",
  insufficient_data: "Dados insuficientes",
};

const severityLabel: Record<AnalysisItem["severity"], string> = {
  critical: "Crítica",
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

function formatEvidenceTime(value: string) {
  return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function IncidentAnalysis({ signedIn, workspaceReady }: { signedIn: boolean; workspaceReady: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [checkingConfig, setCheckingConfig] = useState(false);
  const [configError, setConfigError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<IncidentAnalysisResult | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setEnabled(null);
      setCheckingConfig(false);
      setConfigError("");
      setResult(null);
      return;
    }

    const abort = new AbortController();
    setCheckingConfig(true);
    setConfigError("");
    void fetch(`${API_BASE}/analysis/status`, { credentials: "include", cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { enabled?: boolean; message?: string };
        if (!response.ok) throw new Error(payload.message || "Não foi possível verificar a configuração.");
        setEnabled(Boolean(payload.enabled));
      })
      .catch((failure) => {
        if (abort.signal.aborted) return;
        setConfigError(failure instanceof Error ? failure.message : "Não foi possível verificar a configuração.");
        setEnabled(false);
      })
      .finally(() => {
        if (!abort.signal.aborted) setCheckingConfig(false);
      });

    return () => abort.abort();
  }, [signedIn]);

  async function runAnalysis() {
    if (!signedIn || !workspaceReady || !enabled || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/analysis/incidents`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({})) as IncidentAnalysisResult & { message?: string | string[] };
      if (!response.ok) {
        const message = Array.isArray(payload.message) ? payload.message.join(" ") : payload.message;
        throw new Error(message || "Não foi possível analisar as evidências.");
      }
      setResult(payload);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível analisar as evidências.");
    } finally {
      setLoading(false);
    }
  }

  const canAnalyze = signedIn && workspaceReady && enabled === true && !checkingConfig && !loading;
  const configMessage = !signedIn
    ? "Entre na sua organização para analisar os dados reais."
    : configError
      ? configError
      : checkingConfig
        ? "Verificando a configuração do serviço."
        : enabled
          ? workspaceReady ? "A leitura usa verificações recentes e incidentes da sua organização." : "A análise ficará disponível quando os dados da organização terminarem de carregar."
          : "Configure OPENAI_API_KEY no servidor para ativar este recurso.";

  return <section className="panel evidence-analysis-panel" aria-labelledby="evidence-analysis-title">
    <div className="evidence-analysis-heading">
      <div>
        <h2 id="evidence-analysis-title">Leitura das evidências</h2>
        <p>Verificações das últimas 24 horas e incidentes recentes.</p>
      </div>
      <button className="evidence-analysis-run" type="button" onClick={runAnalysis} disabled={!canAnalyze} aria-busy={loading}>
        {loading ? "Analisando…" : result ? "Atualizar leitura" : "Analisar período"}
      </button>
    </div>

    <div className="evidence-analysis-content">
      {!result && <p className="evidence-analysis-hint" role={configError || error ? "alert" : "status"}>{configMessage}</p>}
      {error && <p className="evidence-analysis-error" role="alert">{error}</p>}

      {result && <>
        <div className="evidence-analysis-overview">
          <span className={`evidence-analysis-status is-${result.analysis.status}`}>{analysisStatusLabel[result.analysis.status]}</span>
          <p>{result.analysis.overview}</p>
          <small>{result.checksCount} verificações e {result.incidentsCount} incidentes considerados</small>
          <time dateTime={result.generatedAt}>Atualizado {formatEvidenceTime(result.generatedAt)}</time>
        </div>

        <div className="evidence-analysis-columns">
          <section aria-labelledby="evidence-findings-title">
            <h3 id="evidence-findings-title">Sinais observados</h3>
            {result.analysis.findings.length === 0
              ? <p className="evidence-analysis-empty">Nenhum sinal sustentado pelas evidências disponíveis.</p>
              : <ul className="evidence-analysis-list">{result.analysis.findings.map((item, index) => <li className="evidence-analysis-item" key={`${item.title}-${index}`}>
                <div className="evidence-analysis-item-head"><b>{item.title}</b><span className={`evidence-severity is-${item.severity}`}>{severityLabel[item.severity]}</span></div>
                <p>{item.detail}</p>
                {item.evidence.length > 0 && <ul className="evidence-reference-list">{item.evidence.map((reference) => <li key={reference.ref}>
                  <span>{reference.ref}</span><time dateTime={reference.occurredAt}>{formatEvidenceTime(reference.occurredAt)}</time><small>{reference.service}: {reference.summary}</small>
                </li>)}</ul>}
              </li>)}</ul>}
          </section>

          <section aria-labelledby="evidence-actions-title">
            <h3 id="evidence-actions-title">Próximos passos</h3>
            {result.analysis.actions.length === 0
              ? <p className="evidence-analysis-empty">Sem ações sugeridas para este conjunto de dados.</p>
              : <ul className="evidence-analysis-list">{result.analysis.actions.map((item, index) => <li className="evidence-analysis-item" key={`${item.title}-${index}`}>
                <div className="evidence-analysis-item-head"><b>{item.title}</b><span className={`evidence-severity is-${item.severity}`}>{severityLabel[item.severity]}</span></div>
                <p>{item.detail}</p>
                {item.evidence.length > 0 && <ul className="evidence-reference-list">{item.evidence.map((reference) => <li key={reference.ref}>
                  <span>{reference.ref}</span><time dateTime={reference.occurredAt}>{formatEvidenceTime(reference.occurredAt)}</time><small>{reference.service}: {reference.summary}</small>
                </li>)}</ul>}
              </li>)}</ul>}
          </section>
        </div>
      </>}

      <p className="evidence-analysis-privacy">Ao analisar, são enviados status HTTP, latência, horários e severidade. Nomes, URLs e mensagens de erro permanecem no NEXUS.</p>
    </div>
  </section>;
}
