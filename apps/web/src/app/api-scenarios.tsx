"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { load as parseYaml } from "js-yaml";

type ScenarioMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type AssertionType = "STATUS_CODE" | "BODY_CONTAINS" | "RESPONSE_TIME_MS";
type RunStatus = "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "ERROR";
type Assertion = { type: AssertionType; expected: string };
type AssertionResult = Assertion & { actual: string; passed: boolean };
type HeaderDraft = { name: string; mode: "plain" | "secret"; value: string; secretId: string; prefix: string };
type HeaderConfig = { name: string; value?: string; secretId?: string; prefix?: string };
type ScenarioSecret = { id: string; name: string; type: "API_CREDENTIAL" | "SLACK_WEBHOOK"; createdAt: string; updatedAt: string };
type ScenarioRun = {
  id: string;
  status: RunStatus;
  trigger: "MANUAL" | "SCHEDULED" | "COLLECTION";
  assertionResults: AssertionResult[] | null;
  responseStatusCode: number | null;
  responseTimeMs: number | null;
  responsePreview: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
type Scenario = {
  id: string;
  collectionName: string;
  name: string;
  method: ScenarioMethod;
  url: string;
  body: string | null;
  assertions: Assertion[];
  headers: HeaderConfig[];
  scheduleIntervalSec: number | null;
  slackWebhookSecretId: string | null;
  updatedAt: string;
  runs: Pick<ScenarioRun, "id" | "status" | "trigger" | "responseStatusCode" | "responseTimeMs" | "error" | "queuedAt" | "completedAt">[];
};
type Draft = { collectionName: string; name: string; method: ScenarioMethod; url: string; body: string; assertions: Assertion[]; headers: HeaderDraft[]; scheduleIntervalSec: number | null; slackWebhookSecretId: string };
type OpenApiOperation = { id: number; method: ScenarioMethod; path: string; name: string; body: string | null };
type OpenApiImportDraft = { collectionName: string; baseUrl: string; operations: OpenApiOperation[]; selectedIds: number[] };
type Session = { organization: { id: string; role: string } };

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api").replace(/\/$/, "");
const methods: ScenarioMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const assertionTypes: AssertionType[] = ["STATUS_CODE", "BODY_CONTAINS", "RESPONSE_TIME_MS"];
const labels: Record<AssertionType, string> = {
  STATUS_CODE: "Código HTTP",
  BODY_CONTAINS: "Texto na resposta",
  RESPONSE_TIME_MS: "Tempo máximo",
};

class ScenarioRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function scenarioRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as { message?: string | string[] } & T;
  if (!response.ok) {
    const message = Array.isArray(payload.message) ? payload.message.join(" ") : payload.message;
    throw new ScenarioRequestError(message || `A solicitação falhou (${response.status}).`, response.status);
  }
  return payload;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Não foi possível concluir a solicitação.";
}

function statusLabel(status: RunStatus) {
  return ({ QUEUED: "Na fila", RUNNING: "Executando", PASSED: "Aprovado", FAILED: "Falhou", ERROR: "Erro" })[status];
}

function assertionValue(type: AssertionType, expected: string) {
  if (type === "STATUS_CODE") return `HTTP ${expected}`;
  if (type === "RESPONSE_TIME_MS") return `até ${expected} ms`;
  return `contém “${expected}”`;
}

function scheduleLabel(intervalSec: number) {
  return ({ 300: "5 minutos", 900: "15 minutos", 3600: "1 hora", 86400: "24 horas" } as Record<number, string>)[intervalSec] ?? `${Math.floor(intervalSec / 60)} minutos`;
}

function newHeaderDraft(): HeaderDraft {
  return { name: "", mode: "plain", value: "", secretId: "", prefix: "" };
}

function isSensitiveHeader(name: string) {
  const normalized = name.trim().toLowerCase();
  return ["authorization", "proxy-authorization", "x-api-key", "api-key", "x-auth-token"].includes(normalized) || /(^|[-_])(?:auth|token|secret|api[-_]?key)(?:$|[-_])/.test(normalized);
}

function newDraft(collectionName = "Geral"): Draft {
  return {
    collectionName,
    name: "",
    method: "GET",
    url: "",
    body: "",
    assertions: [{ type: "STATUS_CODE", expected: "200" }],
    headers: [],
    scheduleIntervalSec: null,
    slackWebhookSecretId: "",
  };
}

function draftFromScenario(scenario: Scenario): Draft {
  return {
    collectionName: scenario.collectionName,
    name: scenario.name,
    method: scenario.method,
    url: scenario.url,
    body: scenario.body ?? "",
    assertions: scenario.assertions.map((assertion) => ({ ...assertion })),
    headers: scenario.headers.map((header) => ({ name: header.name, mode: header.secretId ? "secret" : "plain", value: header.value ?? "", secretId: header.secretId ?? "", prefix: header.prefix ?? "" })),
    scheduleIntervalSec: scenario.scheduleIntervalSec,
    slackWebhookSecretId: scenario.slackWebhookSecretId ?? "",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function openApiBaseUrl(spec: Record<string, unknown>) {
  if (Array.isArray(spec.servers)) {
    const server = asRecord(spec.servers[0]);
    if (typeof server?.url === "string") {
      const variables = asRecord(server.variables);
      return server.url.replace(/\{([^}]+)\}/g, (_match, name: string) => {
        const variable = asRecord(variables?.[name]);
        return typeof variable?.default === "string" ? variable.default : `{${name}}`;
      }).replace(/\/$/, "");
    }
  }
  if (typeof spec.host === "string" && spec.host.trim()) {
    const schemes = Array.isArray(spec.schemes) ? spec.schemes : [];
    const scheme = schemes.find((item): item is string => item === "https" || item === "http") ?? "https";
    const basePath = typeof spec.basePath === "string" ? spec.basePath : "";
    return `${scheme}://${spec.host}${basePath.startsWith("/") ? basePath : `/${basePath}`}`.replace(/\/$/, "");
  }
  return "";
}

function openApiBody(operation: Record<string, unknown>) {
  const requestBody = asRecord(operation.requestBody);
  const content = asRecord(requestBody?.content);
  const jsonMedia = Object.entries(content ?? {}).find(([mediaType]) => mediaType.toLowerCase() === "application/json" || mediaType.toLowerCase().endsWith("+json"))?.[1];
  const media = asRecord(jsonMedia);
  let example: unknown = media?.example;
  if (example === undefined) {
    const examples = asRecord(media?.examples);
    const firstExample = examples ? asRecord(Object.values(examples)[0]) : null;
    if (firstExample && "value" in firstExample) example = firstExample.value;
  }
  if (example === undefined) {
    const schema = asRecord(media?.schema);
    if (schema && "example" in schema) example = schema.example;
  }
  if (example === undefined) {
    const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
    const bodyParameter = parameters.map(asRecord).find((parameter) => parameter?.in === "body");
    const schema = asRecord(bodyParameter?.schema);
    if (schema && "example" in schema) example = schema.example;
  }
  if (example === undefined) return null;
  try {
    const body = JSON.stringify(example, null, 2);
    return body && body.length <= 5000 ? body : null;
  } catch {
    return null;
  }
}

function readOpenApiSpec(source: string, fileName: string) {
  const parsed = fileName.toLowerCase().endsWith(".json") ? JSON.parse(source) : parseYaml(source);
  const spec = asRecord(parsed);
  if (!spec || !(typeof spec.openapi === "string" || spec.swagger === "2.0") || !asRecord(spec.paths)) {
    throw new Error("O arquivo precisa conter uma especificação OpenAPI 3 ou Swagger 2 com paths.");
  }
  const operations: OpenApiOperation[] = [];
  const paths = asRecord(spec.paths)!;
  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = asRecord(rawPathItem);
    if (!pathItem) continue;
    for (const method of methods) {
      const operation = asRecord(pathItem[method.toLowerCase()]);
      if (!operation) continue;
      const summary = typeof operation.summary === "string" ? operation.summary : "";
      const operationId = typeof operation.operationId === "string" ? operation.operationId : "";
      const name = `${method} ${operationId || summary || path}`.replace(/\s+/g, " ").trim().slice(0, 80);
      operations.push({ id: operations.length, method, path, name, body: openApiBody(operation) });
    }
  }
  if (operations.length === 0) throw new Error("Nenhuma operação GET, POST, PUT, PATCH ou DELETE foi encontrada.");
  return { spec, operations };
}

export function ApiScenarioWorkspace({
  session,
  createOpen,
  onCreateOpen,
  onCreateClose,
  onSignIn,
}: {
  session: Session | null;
  createOpen: boolean;
  onCreateOpen: () => void;
  onCreateClose: () => void;
  onSignIn: () => void;
}) {
  const canWrite = Boolean(session && session.organization.role !== "VIEWER");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [secrets, setSecrets] = useState<ScenarioSecret[]>([]);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScenarioRun[]>([]);
  const [listLoading, setListLoading] = useState(Boolean(session));
  const [listError, setListError] = useState("");
  const [runsError, setRunsError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [collectionFilter, setCollectionFilter] = useState("");
  const [openApiOpen, setOpenApiOpen] = useState(false);
  const [editing, setEditing] = useState<Scenario | null>(null);
  const listRequestId = useRef(0);
  const historyRequestId = useRef(0);

  const refreshSecrets = useCallback(async () => {
    if (!session) return;
    const nextSecrets = await scenarioRequest<ScenarioSecret[]>("/scenario-secrets");
    setSecrets(nextSecrets);
  }, [session?.organization.id]);

  const refreshRuns = useCallback(async (scenarioId: string, showError = true) => {
    const requestId = ++historyRequestId.current;
    try {
      const history = await scenarioRequest<ScenarioRun[]>(`/scenarios/${encodeURIComponent(scenarioId)}/runs?limit=20`);
      if (requestId !== historyRequestId.current) return null;
      setRuns(history);
      setRunsError("");
      return history;
    } catch (error) {
      if (requestId === historyRequestId.current && showError) setRunsError(errorText(error));
      return null;
    }
  }, [session?.organization.id]);

  const refreshScenarios = useCallback(async (showLoading = true) => {
    if (!session) return;
    const requestId = ++listRequestId.current;
    if (showLoading) setListLoading(true);
    setListError("");
    try {
      const nextScenarios = await scenarioRequest<Scenario[]>("/scenarios");
      if (requestId !== listRequestId.current) return;
      setScenarios(nextScenarios);
      setSelectedId((current) => current && nextScenarios.some((scenario) => scenario.id === current) ? current : nextScenarios[0]?.id ?? null);
    } catch (error) {
      if (requestId === listRequestId.current) setListError(errorText(error));
    } finally {
      if (requestId === listRequestId.current && showLoading) setListLoading(false);
    }
  }, [session?.organization.id]);

  useEffect(() => {
    if (!session) {
      listRequestId.current += 1;
      historyRequestId.current += 1;
      setScenarios([]);
      setSecrets([]);
      setSelectedId(null);
      setRuns([]);
      setListLoading(false);
      return;
    }
    void refreshScenarios();
    void refreshSecrets().catch(() => setSecrets([]));
  }, [session?.organization.id, refreshScenarios, refreshSecrets]);

  useEffect(() => {
    if (!session || !selectedId) {
      historyRequestId.current += 1;
      setRuns([]);
      setRunsError("");
      return;
    }
    setRuns([]);
    void refreshRuns(selectedId);
    return () => { historyRequestId.current += 1; };
  }, [selectedId, session?.organization.id, refreshRuns]);

  const latestStatus = runs[0]?.status;
  useEffect(() => {
    if (!selectedId || !session || (latestStatus !== "QUEUED" && latestStatus !== "RUNNING")) return;
    const timer = window.setInterval(() => void refreshRuns(selectedId, false), 1800);
    return () => window.clearInterval(timer);
  }, [latestStatus, refreshRuns, selectedId, session?.organization.id]);

  const selected = scenarios.find((scenario) => scenario.id === selectedId) ?? null;
  const collectionNames = useMemo(() => [...new Set(scenarios.map((scenario) => scenario.collectionName))].sort((a, b) => a.localeCompare(b)), [scenarios]);
  const collectionScenarios = useMemo(() => scenarios.filter((scenario) => scenario.collectionName === collectionFilter), [collectionFilter, scenarios]);
  const collectionActive = collectionScenarios.some((scenario) => {
    const latest = scenario.id === selectedId ? runs[0] : scenario.runs[0];
    return latest?.trigger === "COLLECTION" && (latest.status === "QUEUED" || latest.status === "RUNNING");
  });
  const visibleScenarios = useMemo(() => {
    const value = filter.trim().toLocaleLowerCase();
    return scenarios.filter((scenario) => (!collectionFilter || scenario.collectionName === collectionFilter) && (!value || `${scenario.collectionName} ${scenario.name} ${scenario.method} ${scenario.url}`.toLocaleLowerCase().includes(value)));
  }, [collectionFilter, filter, scenarios]);
  const editorOpen = createOpen || editing !== null;

  useEffect(() => {
    if (!session || !collectionActive) return;
    const timer = window.setInterval(() => void refreshScenarios(false), 1800);
    return () => window.clearInterval(timer);
  }, [collectionActive, refreshScenarios, session?.organization.id]);

  async function saveScenario(draft: Draft) {
    setActionError("");
    const payload = {
      collectionName: draft.collectionName.trim(),
      name: draft.name.trim(),
      method: draft.method,
      url: draft.url.trim(),
      body: draft.body.trim() || null,
      assertions: draft.assertions,
      headers: draft.headers.map((header) => ({
        name: header.name.trim(),
        ...(header.mode === "secret" ? { secretId: header.secretId, ...(header.prefix.trim() ? { prefix: header.prefix.trim() } : {}) } : { value: header.value }),
      })),
      scheduleIntervalSec: draft.scheduleIntervalSec,
      slackWebhookSecretId: draft.slackWebhookSecretId || null,
    };
    const saved = editing
      ? await scenarioRequest<Scenario>(`/scenarios/${encodeURIComponent(editing.id)}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await scenarioRequest<Scenario>("/scenarios", { method: "POST", body: JSON.stringify(payload) });
    await refreshScenarios();
    setSelectedId(saved.id);
    setEditing(null);
    onCreateClose();
  }

  async function runScenario() {
    if (!selected || !canWrite) return;
    setActionBusy(true);
    setActionError("");
    try {
      await scenarioRequest<ScenarioRun>(`/scenarios/${encodeURIComponent(selected.id)}/run`, { method: "POST" });
      await refreshRuns(selected.id);
      await refreshScenarios(false);
    } catch (error) {
      setActionError(errorText(error));
      await refreshRuns(selected.id);
    } finally {
      setActionBusy(false);
    }
  }

  async function runCollection() {
    if (!collectionFilter || !canWrite || collectionScenarios.length === 0) return;
    setActionBusy(true);
    setActionError("");
    try {
      await scenarioRequest("/scenarios/run-collection", { method: "POST", body: JSON.stringify({ collectionName: collectionFilter }) });
      await refreshScenarios(false);
      if (selectedId) await refreshRuns(selectedId, false);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setActionBusy(false);
    }
  }

  async function importOpenApi(draft: OpenApiImportDraft) {
    const baseUrl = draft.baseUrl.trim().replace(/\/+$/, "");
    const requests = draft.operations.filter((operation) => draft.selectedIds.includes(operation.id)).map((operation) => ({
      name: operation.name,
      method: operation.method,
      url: `${baseUrl}/${operation.path.replace(/^\/+/, "")}`,
      ...(operation.body ? { body: operation.body } : {}),
    }));
    setActionBusy(true);
    setActionError("");
    try {
      const imported = await scenarioRequest<Scenario[]>("/scenarios/import", { method: "POST", body: JSON.stringify({ collectionName: draft.collectionName.trim(), requests }) });
      await refreshScenarios(false);
      setCollectionFilter(draft.collectionName.trim());
      setSelectedId(imported[0]?.id ?? null);
      setOpenApiOpen(false);
    } catch (error) {
      throw new Error(errorText(error));
    } finally {
      setActionBusy(false);
    }
  }

  async function deleteScenario() {
    if (!selected || !canWrite) return;
    if (!window.confirm(`Excluir o cenário “${selected.name}” e todo o histórico de execuções?`)) return;
    setActionBusy(true);
    setActionError("");
    try {
      await scenarioRequest(`/scenarios/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      const remaining = scenarios.filter((scenario) => scenario.id !== selected.id);
      setScenarios(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      setRuns([]);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setActionBusy(false);
    }
  }

  function closeEditor() {
    setEditing(null);
    onCreateClose();
  }

  if (!session) {
    return <section className="scenario-access-state" aria-labelledby="scenario-access-title">
      <span className="scenario-access-mark" aria-hidden="true">{`{ }`}</span>
      <h2 id="scenario-access-title">Seus cenários ficam na sua organização</h2>
      <p>Entre para criar requisições, validar respostas e consultar o histórico de execuções.</p>
      <button className="button button-primary" onClick={onSignIn}>Entrar na NEXUS</button>
    </section>;
  }

  return <>
    <section className="scenario-workspace" aria-label="Workspace de testes de API">
      <aside className="scenario-list panel" aria-label="Cenários salvos">
        <div className="scenario-list-head">
          <div><h2>Cenários</h2><span>{scenarios.length} salvos</span></div>
          {canWrite && <div className="scenario-list-tools"><button className="scenario-secret-button" onClick={() => setSecretsOpen(true)}>Credenciais</button><button className="scenario-add-compact" aria-label="Criar cenário" onClick={() => { setEditing(null); onCreateOpen(); }}>+</button></div>}
        </div>
        <div className="scenario-collection-controls">
          <label><span>Coleção</span><select value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)} aria-label="Filtrar por coleção"><option value="">Todas as coleções</option>{collectionNames.map((name) => <option value={name} key={name}>{name}</option>)}</select></label>
          <div className="scenario-collection-actions">
            {canWrite && <button className="scenario-secret-button" onClick={() => setOpenApiOpen(true)}>Importar OpenAPI</button>}
            <button className="scenario-sequence-button" disabled={!canWrite || !collectionFilter || collectionScenarios.length === 0 || actionBusy || collectionActive} onClick={() => void runCollection()} title={!collectionFilter ? "Escolha uma coleção para executar" : undefined}>{collectionActive ? "Sequência em execução" : actionBusy ? "Enfileirando…" : "Executar sequência"}</button>
          </div>
        </div>
        {scenarios.length > 0 && <label className="scenario-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filtrar cenários" aria-label="Filtrar cenários" /></label>}
        {listLoading ? <div className="scenario-list-loading" role="status"><i /><i /><i /></div>
          : listError ? <div className="scenario-list-state is-error" role="alert"><b>Não foi possível carregar</b><span>{listError}</span><button className="scenario-link-button" onClick={() => void refreshScenarios()}>Tentar novamente</button></div>
              : scenarios.length === 0 ? <div className="scenario-list-state"><b>Nenhum cenário salvo</b><span>Crie uma requisição para começar a validar sua API.</span>{canWrite && <button className="scenario-link-button" onClick={() => { setEditing(null); onCreateOpen(); }}>Criar primeiro cenário</button>}</div>
              : visibleScenarios.length === 0 ? <div className="scenario-list-state"><b>Nenhum resultado</b><span>Tente outro nome, método ou endereço.</span></div>
                : <div className="scenario-nav-list">{visibleScenarios.map((scenario) => {
                  const latest = scenario.id === selectedId ? runs[0] : scenario.runs[0];
                  return <button key={scenario.id} className={scenario.id === selectedId ? "scenario-nav-item is-selected" : "scenario-nav-item"} onClick={() => { setSelectedId(scenario.id); setActionError(""); }} aria-current={scenario.id === selectedId ? "page" : undefined}>
                    <span className={`scenario-method method-${scenario.method.toLowerCase()}`}>{scenario.method}</span>
                    <span className="scenario-nav-copy"><b>{scenario.name}</b><small>{scenario.collectionName} · {scenario.url}</small></span>
                    {latest && <span className={`scenario-nav-status status-${latest.status.toLowerCase()}`} title={statusLabel(latest.status)} />}
                  </button>;
                })}</div>}
        <div className="scenario-list-foot"><span className="scenario-safety-dot" />HTTP/HTTPS público</div>
      </aside>

      <section className="scenario-detail panel">
        {selected ? <>
          <header className="scenario-detail-head">
            <div className="scenario-title-copy">
              <div className="scenario-title-line"><span className={`scenario-method method-${selected.method.toLowerCase()}`}>{selected.method}</span><h2>{selected.name}</h2></div>
              <code className="scenario-endpoint">{selected.url}</code>
            </div>
            <div className="scenario-detail-actions">
              <button className="button button-primary scenario-run-button" disabled={!canWrite || actionBusy || latestStatus === "QUEUED" || latestStatus === "RUNNING"} title={!canWrite ? "Seu perfil pode consultar, mas não executar cenários." : undefined} onClick={() => void runScenario()}>{actionBusy ? "Enfileirando…" : latestStatus === "QUEUED" || latestStatus === "RUNNING" ? "Executando…" : "Executar cenário"}</button>
              {canWrite && <button className="button button-quiet" disabled={actionBusy} onClick={() => setEditing(selected)}>Editar</button>}
              {canWrite && <button className="scenario-delete-button" disabled={actionBusy} onClick={() => void deleteScenario()}>Excluir</button>}
            </div>
          </header>
          <div className="scenario-assertion-strip" aria-label="Validações configuradas">
            <span>Validar resposta</span>
            {selected.assertions.map((assertion, index) => <span key={`${assertion.type}-${index}`} className="scenario-assertion-chip"><i />{labels[assertion.type]} <b>{assertionValue(assertion.type, assertion.expected)}</b></span>)}
          </div>
          <div className="scenario-automation-strip" aria-label="Agendamento e alertas">
            <span><i className={selected.scheduleIntervalSec ? "is-active" : ""} />{selected.scheduleIntervalSec ? `A cada ${scheduleLabel(selected.scheduleIntervalSec)}` : "Sem agendamento"}</span>
            <span><i className={selected.slackWebhookSecretId ? "is-active" : ""} />{selected.slackWebhookSecretId ? "Alertas no Slack ativos" : "Alertas no Slack desativados"}</span>
            {selected.headers.length > 0 && <span>{selected.headers.length} cabeçalho{selected.headers.length === 1 ? "" : "s"} configurado{selected.headers.length === 1 ? "" : "s"}</span>}
          </div>
          {actionError && <div className="scenario-inline-error" role="alert">{actionError}</div>}
          {!canWrite && <p className="scenario-permission-note">Seu perfil pode consultar cenários e resultados. A execução e edição exigem permissão de gravação.</p>}

          <section className="scenario-runs" aria-labelledby="scenario-runs-title">
            <div className="scenario-runs-heading"><div><h3 id="scenario-runs-title">Execuções recentes</h3><p>Até 20 resultados deste cenário</p></div><span>{runs.length.toString().padStart(2, "0")}</span></div>
            {runsError ? <div className="scenario-result-state is-error" role="alert"><b>Não foi possível carregar o histórico</b><span>{runsError}</span><button className="scenario-link-button" onClick={() => void refreshRuns(selected.id)}>Tentar novamente</button></div>
              : runs.length === 0 ? <div className="scenario-result-state"><span className="scenario-empty-glyph" aria-hidden="true">—</span><b>Ainda sem execuções</b><span>Execute o cenário para ver as validações e a resposta recebida.</span></div>
                : <ol className="scenario-run-list">{runs.map((run) => <li key={run.id} className="scenario-run-row">
                  <div className="scenario-run-main">
                    <span className={`scenario-run-state status-${run.status.toLowerCase()}`}><i />{statusLabel(run.status)}</span>
                    <span className="scenario-run-meta">{run.trigger === "SCHEDULED" ? "Agendada" : run.trigger === "COLLECTION" ? "Sequência" : "Manual"}</span>
                    <span className="scenario-run-meta">{run.responseStatusCode ? `HTTP ${run.responseStatusCode}` : run.status === "QUEUED" || run.status === "RUNNING" ? "Aguardando resposta" : "Sem resposta HTTP"}</span>
                    {run.responseTimeMs !== null && <span className="scenario-run-meta">{run.responseTimeMs} ms</span>}
                    <time dateTime={run.queuedAt}>{new Date(run.queuedAt).toLocaleString("pt-BR", { dateStyle: "medium", timeStyle: "short" })}</time>
                  </div>
                  {run.error && <p className="scenario-run-error">{run.error}</p>}
                  {run.assertionResults && run.assertionResults.length > 0 && <ul className="scenario-check-results">{run.assertionResults.map((result, index) => <li key={`${result.type}-${index}`} className={result.passed ? "is-passed" : "is-failed"}><span aria-hidden="true">{result.passed ? "✓" : "×"}</span><b>{labels[result.type]}</b><span>{assertionValue(result.type, result.expected)}</span><small>{result.actual}</small></li>)}</ul>}
                  {run.responsePreview && <details className="scenario-response"><summary>Ver prévia da resposta</summary><pre>{run.responsePreview}</pre></details>}
                </li>)}</ol>}
          </section>
        </> : <div className="scenario-detail-empty"><span className="scenario-empty-glyph" aria-hidden="true">{`{ }`}</span><h2>{listLoading ? "Carregando cenários" : "Escolha um cenário"}</h2><p>{listLoading ? "Buscando a coleção da sua organização." : "Selecione um cenário na lista para revisar as validações e o histórico."}</p></div>}
      </section>
    </section>
    {editorOpen && <ScenarioEditor
      key={editing?.id ?? "new-scenario"}
      scenario={editing}
      initialCollectionName={collectionFilter || selected?.collectionName || "Geral"}
      secrets={secrets}
      onClose={closeEditor}
      onSave={saveScenario}
    />}
    {secretsOpen && <ScenarioSecretsManager onClose={() => setSecretsOpen(false)} onChanged={() => void refreshSecrets().catch(() => setSecrets([]))} />}
    {openApiOpen && <OpenApiImportDialog initialCollectionName={collectionFilter || selected?.collectionName || "Importada do OpenAPI"} onClose={() => setOpenApiOpen(false)} onImport={importOpenApi} />}
  </>;
}

function ScenarioEditor({ scenario, initialCollectionName, secrets, onClose, onSave }: { scenario: Scenario | null; initialCollectionName: string; secrets: ScenarioSecret[]; onClose: () => void; onSave: (draft: Draft) => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>(() => scenario ? draftFromScenario(scenario) : newDraft(initialCollectionName));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bodyAllowed = draft.method !== "GET";

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  function updateAssertion(index: number, update: Partial<Assertion>) {
    setDraft((current) => ({ ...current, assertions: current.assertions.map((item, itemIndex) => itemIndex === index ? { ...item, ...update } : item) }));
  }

  function updateHeader(index: number, update: Partial<HeaderDraft>) {
    setDraft((current) => ({ ...current, headers: current.headers.map((header, headerIndex) => {
      if (headerIndex !== index) return header;
      const next = { ...header, ...update };
      if (update.name !== undefined && isSensitiveHeader(update.name)) return { ...next, mode: "secret" as const, value: "" };
      if (update.mode === "secret") return { ...next, value: "", prefix: next.prefix || (next.name.toLowerCase() === "authorization" ? "Bearer " : "") };
      if (update.mode === "plain") return { ...next, secretId: "", prefix: "" };
      return next;
    }) }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (bodyAllowed && draft.body.trim()) {
      try { JSON.parse(draft.body); } catch { setError("O corpo precisa ser JSON válido."); return; }
    }
    if (draft.assertions.some((assertion) => !assertion.expected.trim())) {
      setError("Preencha o valor de todas as validações.");
      return;
    }
    if (draft.headers.some((header) => !header.name.trim() || (header.mode === "secret" && !header.secretId) || (isSensitiveHeader(header.name) && header.mode !== "secret"))) {
      setError("Complete os cabeçalhos e use o cofre para valores de autenticação.");
      return;
    }
    setBusy(true);
    try { await onSave({ ...draft, body: bodyAllowed ? draft.body : "" }); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop scenario-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal scenario-editor" role="dialog" aria-modal="true" aria-labelledby="scenario-editor-title">
      <header className="modal-head"><div><h2 id="scenario-editor-title">{scenario ? "Editar cenário" : "Novo cenário"}</h2><p>Configure a requisição e o que a resposta precisa cumprir.</p></div><button className="icon-button" aria-label="Fechar" disabled={busy} onClick={onClose}>×</button></header>
      <form className="monitor-form scenario-form" onSubmit={(event) => void submit(event)}>
        <label>Coleção<input required minLength={2} maxLength={80} value={draft.collectionName} onChange={(event) => setDraft({ ...draft, collectionName: event.target.value })} placeholder="Ex.: Produção" /></label>
        <label>Nome do cenário<input autoFocus required minLength={2} maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Ex.: Health check de pagamentos" /></label>
        <div className="scenario-request-fields">
          <label>Método<select value={draft.method} onChange={(event) => setDraft({ ...draft, method: event.target.value as ScenarioMethod, body: event.target.value === "GET" ? "" : draft.body })}>{methods.map((method) => <option key={method}>{method}</option>)}</select></label>
          <label>URL da API<input required type="url" maxLength={2048} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://api.exemplo.com/v1/health" /></label>
        </div>
        <p className="scenario-form-note">HTTP/HTTPS em endereços públicos. Credenciais de autenticação são carregadas do cofre apenas durante a execução.</p>
        <fieldset className="scenario-header-editor"><legend>Cabeçalhos da requisição <span className="scenario-optional">Opcional</span></legend>
          {draft.headers.map((header, index) => <div className="scenario-header-edit-row" key={index}>
            <label><span className="sr-only">Nome do cabeçalho {index + 1}</span><input required maxLength={80} value={header.name} onChange={(event) => updateHeader(index, { name: event.target.value })} placeholder="X-Client-Version" /></label>
            <label><span className="sr-only">Armazenamento do cabeçalho {index + 1}</span><select value={header.mode} onChange={(event) => updateHeader(index, { mode: event.target.value as HeaderDraft["mode"] })}><option value="plain" disabled={isSensitiveHeader(header.name)}>Valor fixo</option><option value="secret">Cofre</option></select></label>
            {header.mode === "secret" ? <div className="scenario-header-secret-fields"><label><span className="sr-only">Credencial para {header.name || `cabeçalho ${index + 1}`}</span><select required value={header.secretId} onChange={(event) => updateHeader(index, { secretId: event.target.value })}><option value="">Escolha uma credencial</option>{secrets.filter((secret) => secret.type === "API_CREDENTIAL").map((secret) => <option value={secret.id} key={secret.id}>{secret.name}</option>)}</select></label><label><span className="sr-only">Prefixo opcional para {header.name}</span><input maxLength={40} value={header.prefix} onChange={(event) => updateHeader(index, { prefix: event.target.value })} placeholder="Prefixo · ex.: Bearer " /></label></div>
              : <label><span className="sr-only">Valor de {header.name || `cabeçalho ${index + 1}`}</span><input maxLength={2048} value={header.value} onChange={(event) => updateHeader(index, { value: event.target.value })} placeholder="Valor não sensível" /></label>}
            <button type="button" className="scenario-remove-check" aria-label={`Remover cabeçalho ${index + 1}`} onClick={() => setDraft((current) => ({ ...current, headers: current.headers.filter((_item, headerIndex) => headerIndex !== index) }))}>×</button>
          </div>)}
          <button type="button" className="scenario-add-check" disabled={draft.headers.length >= 20} onClick={() => setDraft((current) => ({ ...current, headers: [...current.headers, newHeaderDraft()] }))}>+ Adicionar cabeçalho <span>{draft.headers.length}/20</span></button>
        </fieldset>
        {bodyAllowed && <label>Corpo JSON <span className="scenario-optional">Opcional</span><textarea maxLength={5000} rows={5} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} placeholder={'{\n  "example": true\n}'} spellCheck={false} /></label>}
        <div className="scenario-schedule-grid">
          <label>Execução recorrente<select value={draft.scheduleIntervalSec ?? ""} onChange={(event) => setDraft({ ...draft, scheduleIntervalSec: event.target.value ? Number(event.target.value) : null })}><option value="">Desativada</option><option value="300">A cada 5 minutos</option><option value="900">A cada 15 minutos</option><option value="3600">A cada 1 hora</option><option value="86400">A cada 24 horas</option></select></label>
          <label>Alertas de falha no Slack<select value={draft.slackWebhookSecretId} onChange={(event) => setDraft({ ...draft, slackWebhookSecretId: event.target.value })}><option value="">Desativados</option>{secrets.filter((secret) => secret.type === "SLACK_WEBHOOK").map((secret) => <option value={secret.id} key={secret.id}>{secret.name}</option>)}</select></label>
        </div>
        <fieldset className="scenario-assertion-editor"><legend>Validar resposta</legend>
          {draft.assertions.map((assertion, index) => <div className="scenario-assertion-edit-row" key={index}>
            <label><span className="sr-only">Tipo da validação {index + 1}</span><select value={assertion.type} onChange={(event) => updateAssertion(index, { type: event.target.value as AssertionType, expected: event.target.value === "STATUS_CODE" ? "200" : event.target.value === "RESPONSE_TIME_MS" ? "1000" : "" })}>{assertionTypes.map((type) => <option value={type} key={type}>{labels[type]}</option>)}</select></label>
            <label><span className="sr-only">Valor da validação {index + 1}</span><input type={assertion.type === "STATUS_CODE" || assertion.type === "RESPONSE_TIME_MS" ? "number" : "text"} min={assertion.type === "STATUS_CODE" ? 100 : 1} max={assertion.type === "STATUS_CODE" ? 599 : assertion.type === "RESPONSE_TIME_MS" ? 10000 : undefined} maxLength={250} value={assertion.expected} onChange={(event) => updateAssertion(index, { expected: event.target.value })} placeholder={assertion.type === "BODY_CONTAINS" ? "Trecho de texto esperado" : assertion.type === "STATUS_CODE" ? "200" : "1000"} /></label>
            <button type="button" className="scenario-remove-check" aria-label={`Remover validação ${index + 1}`} disabled={draft.assertions.length <= 1} onClick={() => setDraft((current) => ({ ...current, assertions: current.assertions.filter((_item, itemIndex) => itemIndex !== index) }))}>×</button>
          </div>)}
          <button type="button" className="scenario-add-check" disabled={draft.assertions.length >= 10} onClick={() => setDraft((current) => ({ ...current, assertions: [...current.assertions, { type: "BODY_CONTAINS", expected: "" }] }))}>+ Adicionar validação <span>{draft.assertions.length}/10</span></button>
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button button-quiet" disabled={busy} onClick={onClose}>Cancelar</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? "Salvando…" : scenario ? "Salvar alterações" : "Criar cenário"}</button></div>
      </form>
    </section>
  </div>;
}

function OpenApiImportDialog({ initialCollectionName, onClose, onImport }: { initialCollectionName: string; onClose: () => void; onImport: (draft: OpenApiImportDraft) => Promise<void> }) {
  const [draft, setDraft] = useState<OpenApiImportDraft>({ collectionName: initialCollectionName, baseUrl: "", operations: [], selectedIds: [] });
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  async function readFile(file: File) {
    setError("");
    setFileName(file.name);
    if (file.size > 5 * 1024 * 1024) {
      setDraft((current) => ({ ...current, operations: [], selectedIds: [] }));
      setError("O arquivo excede o limite de 5 MB.");
      return;
    }
    try {
      const { spec, operations } = readOpenApiSpec(await file.text(), file.name);
      setDraft((current) => ({
        ...current,
        baseUrl: current.baseUrl || openApiBaseUrl(spec),
        operations,
        selectedIds: operations.slice(0, 100).map((operation) => operation.id),
      }));
    } catch (failure) {
      setDraft((current) => ({ ...current, operations: [], selectedIds: [] }));
      setError(errorText(failure));
    }
  }

  function toggleOperation(id: number) {
    setDraft((current) => {
      const selected = current.selectedIds.includes(id);
      if (!selected && current.selectedIds.length >= 100) return current;
      return { ...current, selectedIds: selected ? current.selectedIds.filter((item) => item !== id) : [...current.selectedIds, id] };
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (draft.selectedIds.length === 0 || draft.selectedIds.length > 100) {
      setError("Selecione entre 1 e 100 operações para importar.");
      return;
    }
    try {
      const base = new URL(draft.baseUrl.trim());
      if (!(["http:", "https:"].includes(base.protocol)) || !base.hostname) throw new Error("Informe uma URL HTTP ou HTTPS válida.");
    } catch {
      setError("Informe a URL base da API, incluindo https://.");
      return;
    }
    setBusy(true);
    try { await onImport(draft); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop scenario-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal scenario-openapi-modal" role="dialog" aria-modal="true" aria-labelledby="scenario-openapi-title">
      <header className="modal-head"><div><h2 id="scenario-openapi-title">Importar OpenAPI / Swagger</h2><p>Carregue um arquivo JSON ou YAML e escolha as operações que deseja salvar.</p></div><button className="icon-button" aria-label="Fechar importador" disabled={busy} onClick={onClose}>×</button></header>
      <form className="monitor-form scenario-form" onSubmit={(event) => void submit(event)}>
        <label>Arquivo da especificação<input required type="file" accept=".json,.yaml,.yml,application/json,text/yaml" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} /></label>
        {fileName && <p className="scenario-form-note">Arquivo: {fileName}</p>}
        <div className="scenario-openapi-fields">
          <label>Coleção<input required minLength={2} maxLength={80} value={draft.collectionName} onChange={(event) => setDraft({ ...draft, collectionName: event.target.value })} /></label>
          <label>URL base da API<input required type="url" maxLength={2048} value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.exemplo.com/v1" /></label>
        </div>
        <p className="scenario-form-note">As credenciais de segurança descritas no arquivo não incluem segredos. Configure a autenticação no editor após importar; os valores ficam no cofre.</p>
        {draft.operations.length > 0 && <div className="scenario-openapi-operations">
          <div className="scenario-openapi-operations-head"><b>Operações encontradas</b><span>{draft.selectedIds.length}/100 selecionadas</span></div>
          <div className="scenario-openapi-selection"><button type="button" className="scenario-link-button" onClick={() => setDraft((current) => ({ ...current, selectedIds: current.operations.slice(0, 100).map((operation) => operation.id) }))}>Selecionar até 100</button><button type="button" className="scenario-link-button" onClick={() => setDraft((current) => ({ ...current, selectedIds: [] }))}>Limpar seleção</button></div>
          <div className="scenario-openapi-list" role="group" aria-label="Operações a importar">{draft.operations.map((operation) => <label key={operation.id} className="scenario-openapi-row"><input type="checkbox" checked={draft.selectedIds.includes(operation.id)} disabled={!draft.selectedIds.includes(operation.id) && draft.selectedIds.length >= 100} onChange={() => toggleOperation(operation.id)} /><span className={`scenario-method method-${operation.method.toLowerCase()}`}>{operation.method}</span><span><b>{operation.name}</b><small>{operation.path}{operation.body ? " · exemplo JSON incluído" : ""}</small></span></label>)}</div>
        </div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button button-quiet" disabled={busy} onClick={onClose}>Cancelar</button><button type="submit" className="button button-primary" disabled={busy || draft.operations.length === 0}>{busy ? "Importando…" : `Importar ${draft.selectedIds.length || "operações"}`}</button></div>
      </form>
    </section>
  </div>;
}

function ScenarioSecretsManager({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [secrets, setSecrets] = useState<ScenarioSecret[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<ScenarioSecret["type"]>("API_CREDENTIAL");
  const [value, setValue] = useState("");
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const rotating = secrets.find((secret) => secret.id === rotatingId) ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setSecrets(await scenarioRequest<ScenarioSecret[]>("/scenario-secrets")); setError(""); }
    catch (failure) { setError(errorText(failure)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose, refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (rotating) {
        await scenarioRequest(`/scenario-secrets/${encodeURIComponent(rotating.id)}`, { method: "PATCH", body: JSON.stringify({ value }) });
      } else {
        await scenarioRequest("/scenario-secrets", { method: "POST", body: JSON.stringify({ name: name.trim(), type, value }) });
      }
      setName("");
      setValue("");
      setRotatingId(null);
      await refresh();
      onChanged();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  async function remove(secret: ScenarioSecret) {
    if (!window.confirm(`Excluir “${secret.name}”? Cenários que usam essa credencial precisam ser atualizados primeiro.`)) return;
    setBusy(true);
    setError("");
    try {
      await scenarioRequest(`/scenario-secrets/${encodeURIComponent(secret.id)}`, { method: "DELETE" });
      if (rotatingId === secret.id) setRotatingId(null);
      await refresh();
      onChanged();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop scenario-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal scenario-secrets-modal" role="dialog" aria-modal="true" aria-labelledby="scenario-secrets-title">
      <header className="modal-head"><div><h2 id="scenario-secrets-title">Cofre de credenciais</h2><p>Valores criptografados em repouso e ocultos depois de salvos.</p></div><button className="icon-button" aria-label="Fechar cofre" disabled={busy} onClick={onClose}>×</button></header>
      <div className="scenario-secret-list" aria-label="Credenciais salvas">
        {loading ? <p className="scenario-secret-empty" role="status">Carregando credenciais…</p>
          : secrets.length === 0 ? <p className="scenario-secret-empty">Nenhuma credencial salva ainda.</p>
            : secrets.map((secret) => <div className="scenario-secret-row" key={secret.id}>
              <span><b>{secret.name}</b><small>{secret.type === "API_CREDENTIAL" ? "Cabeçalho de API" : "Webhook de Slack"}</small></span>
              <div><button type="button" className="scenario-link-button" disabled={busy} onClick={() => { setRotatingId(secret.id); setValue(""); setName(""); setError(""); }}>Rotacionar</button><button type="button" className="scenario-delete-button" disabled={busy} onClick={() => void remove(secret)}>Excluir</button></div>
            </div>)}
      </div>
      <form className="monitor-form scenario-form scenario-secret-form" onSubmit={(event) => void submit(event)}>
        <h3>{rotating ? `Atualizar ${rotating.name}` : "Adicionar credencial"}</h3>
        {!rotating && <>
          <label>Nome<input required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Produção · API de pagamentos" /></label>
          <label>Tipo<select value={type} onChange={(event) => setType(event.target.value as ScenarioSecret["type"])}><option value="API_CREDENTIAL">Credencial para cabeçalho</option><option value="SLACK_WEBHOOK">Webhook de Slack</option></select></label>
        </>}
        <label>{rotating?.type === "SLACK_WEBHOOK" || (!rotating && type === "SLACK_WEBHOOK") ? "URL do webhook" : "Valor secreto"}<input required type="password" autoComplete="new-password" maxLength={4096} value={value} onChange={(event) => setValue(event.target.value)} placeholder={rotating ? "Digite o novo valor para rotacionar" : type === "SLACK_WEBHOOK" ? "https://hooks.slack.com/services/…" : "Token ou chave de API"} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <p className="scenario-form-note">O NEXUS não retorna o valor salvo pela API. Guarde uma cópia segura antes de fechar.</p>
        <div className="modal-actions">{rotating && <button type="button" className="button button-quiet" disabled={busy} onClick={() => { setRotatingId(null); setValue(""); setError(""); }}>Cancelar rotação</button>}<button type="submit" className="button button-primary" disabled={busy}>{busy ? "Salvando…" : rotating ? "Salvar novo valor" : "Adicionar ao cofre"}</button></div>
      </form>
    </section>
  </div>;
}
