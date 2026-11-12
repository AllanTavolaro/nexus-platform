"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiScenarioWorkspace } from "./api-scenarios";
import { IncidentAnalysis } from "./incident-analysis";
import { StartupSplash } from "./startup-splash";

type Status = "Operacional" | "Degradado" | "Incidente" | "Pendente";
type Monitor = {
  id: string | number;
  name: string;
  url: string;
  group: string;
  status: Status;
  latency: string;
  uptime: string;
  checked: string;
  color: string;
  isActive?: boolean;
  intervalSec?: number;
};
type Session = {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string; role: string };
};
type WorkspaceState = "checking" | "demo" | "loading" | "live" | "error";
type WorkspaceSummary = {
  totalMonitors: number;
  activeMonitors: number;
  checks24h: number;
  availabilityPercent: number | null;
  averageLatencyMs: number | null;
  activeIncidents: number;
};
type AvailabilityPoint = {
  at: string;
  checks: number;
  availabilityPercent: number | null;
};
type AvailabilityHistory = {
  periodHours: number;
  points: AvailabilityPoint[];
};
type ApiMonitor = {
  id: string;
  name: string;
  url: string;
  intervalSec: number;
  isActive: boolean;
  lastCheck: { success: boolean; statusCode: number | null; latencyMs: number; checkedAt: string; error: string | null } | null;
  uptimePercent: number | null;
};
type MonitorCheck = {
  id: string;
  checkedAt: string;
  success: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
};
type IncidentEvent = {
  id: string;
  type: "OPENED" | "RESOLVED";
  message: string | null;
  createdAt: string;
};
type Incident = {
  id: string;
  title: string;
  message: string | null;
  startedAt: string;
  resolvedAt: string | null;
  status: "OPEN" | "RESOLVED";
  monitor: { id: string; name: string; url: string };
  events: IncidentEvent[];
};
type IncidentNotification = {
  id: string;
  kind: "INCIDENT";
  readAt: string | null;
  createdAt: string;
  event: {
    type: "OPENED" | "RESOLVED";
    message: string | null;
    createdAt: string;
    incident: {
      id: string;
      title: string;
      status: "OPEN" | "RESOLVED";
      monitor: { name: string };
    };
  };
};
type ScenarioNotification = {
  id: string;
  kind: "SCENARIO";
  readAt: string | null;
  createdAt: string;
  scenario: { id: string; name: string; method: string };
  run: { status: "FAILED" | "ERROR" | "PASSED"; responseStatusCode: number | null; responseTimeMs: number | null; error: string | null; completedAt: string | null; queuedAt: string };
};
type Notification = IncidentNotification | ScenarioNotification;
type NotificationSnapshot = {
  items: Notification[];
  unreadCount: number;
  emailPreferences: { emailAlertsEnabled: boolean; deliveryConfigured: boolean };
};
type NotificationStreamState = "connecting" | "connected" | "reconnecting";
type IconName = "grid" | "pulse" | "flask" | "alert" | "spark" | "users" | "settings" | "search" | "bell" | "plus" | "arrow" | "dots" | "clock" | "check" | "server" | "x" | "external";

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api").replace(/\/$/, "");

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as { message?: string | string[] } & T;
  if (!response.ok) {
    const message = Array.isArray(payload.message) ? payload.message.join(" ") : payload.message;
    throw new ApiRequestError(message || `Request failed (${response.status}).`, response.status);
  }
  return payload;
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "aguardando primeira verificação";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `há ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `há ${hours} h`;
}

function toDisplayMonitor(monitor: ApiMonitor, index: number): Monitor {
  const color = ["violet", "blue", "teal", "amber"][index % 4];
  const parsedUrl = new URL(monitor.url);
  return {
    id: monitor.id,
    name: monitor.name,
    url: `${parsedUrl.host}${parsedUrl.pathname}`,
    group: "Produção",
    status: !monitor.isActive ? "Pendente" : !monitor.lastCheck ? "Pendente" : monitor.lastCheck.success ? "Operacional" : "Incidente",
    latency: monitor.lastCheck ? `${monitor.lastCheck.latencyMs} ms` : "—",
    uptime: monitor.uptimePercent === null ? "—" : `${monitor.uptimePercent.toFixed(2).replace(".", ",")}%`,
    checked: formatRelativeTime(monitor.lastCheck?.checkedAt),
    color,
    isActive: monitor.isActive,
    intervalSec: monitor.intervalSec,
  };
}

function normalizeMonitorAddress(value: string) {
  try {
    const parsedUrl = new URL(value.includes("://") ? value : `https://${value}`);
    return `${parsedUrl.host}${parsedUrl.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

async function fetchWorkspaceSnapshot() {
  const [apiMonitors, summary, recentIncidents, openIncidents, availability, notifications] = await Promise.all([
    apiRequest<ApiMonitor[]>("/monitors"),
    apiRequest<WorkspaceSummary>("/dashboard"),
    apiRequest<Incident[]>("/incidents"),
    apiRequest<Incident[]>("/incidents?status=OPEN"),
    apiRequest<AvailabilityHistory>("/dashboard/availability"),
    apiRequest<NotificationSnapshot>("/notifications"),
  ]);
  return { monitors: apiMonitors.map(toDisplayMonitor), summary, incidents: recentIncidents, openIncidents, availability, notifications };
}

function formatCount(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(".", ",")}k` : String(value);
}

const seedMonitors: Monitor[] = [
  { id: 1, name: "Payments API", url: "api.stripe.com/v1", group: "Produção", status: "Operacional", latency: "128 ms", uptime: "99,98%", checked: "há 24 s", color: "violet" },
  { id: 2, name: "Identity Service", url: "auth.nexus.app/health", group: "Produção", status: "Operacional", latency: "84 ms", uptime: "99,99%", checked: "há 31 s", color: "blue" },
  { id: 3, name: "Orders Gateway", url: "api.nexus.app/orders", group: "Produção", status: "Degradado", latency: "1.42 s", uptime: "98,72%", checked: "há 18 s", color: "amber" },
  { id: 4, name: "Catalog Service", url: "catalog.nexus.app/health", group: "Staging", status: "Operacional", latency: "206 ms", uptime: "99,95%", checked: "há 42 s", color: "teal" },
];
const demoAvailability = (seedMonitors.reduce((sum, monitor) => sum + Number(monitor.uptime.replace("%", "").replace(",", ".")), 0) / seedMonitors.length).toFixed(2).replace(".", ",");
const demoLatencyMs = Math.round(seedMonitors.reduce((sum, monitor) => {
  const amount = Number.parseFloat(monitor.latency.replace(",", "."));
  return sum + (monitor.latency.endsWith(" s") ? amount * 1000 : amount);
}, 0) / seedMonitors.length);
const demoChecks = formatCount(seedMonitors.length * 24 * 60);
const demoIncidentMonitors = seedMonitors.filter((monitor) => monitor.status === "Degradado" || monitor.status === "Incidente");
const demoIncidentCount = demoIncidentMonitors.length;
const demoFeaturedIncident = demoIncidentMonitors[0] ?? null;
const demoAvailabilityValues = [99.74, 99.71, 99.69, 99.72, 99.73, 99.7, 99.68, 99.71, 99.7, 99.66, 99.72, 99.69, 99.71, 99.7, 99.68, 99.73, 99.69, 99.7, 99.72, 99.68, 99.71, 99.69, 99.7, 98.72];

function createDemoAvailabilityHistory(): AvailabilityPoint[] {
  const firstHour = Date.now() - 24 * 60 * 60 * 1000;
  return demoAvailabilityValues.map((availabilityPercent, index) => ({
    at: new Date(firstHour + (index + 0.5) * 60 * 60 * 1000).toISOString(),
    checks: seedMonitors.length * 60,
    availabilityPercent,
  }));
}

const navigation: { label: string; icon: IconName; section?: string }[] = [
  { label: "Visão geral", icon: "grid", section: "SISTEMA" },
  { label: "Observabilidade", icon: "pulse" },
  { label: "Testes de API", icon: "flask" },
  { label: "Incidentes", icon: "alert" },
];

const activeNavigation = new Set(navigation.map((item) => item.label));

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const shared = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
    pulse: <><path d="M3 12h4l2.4-7 4.1 14 2.3-7H21" /></>,
    flask: <><path d="M9 3h6M10 3v6.5l-5.7 8.1A2.2 2.2 0 0 0 6.1 21h11.8a2.2 2.2 0 0 0 1.8-3.4L14 9.5V3" /><path d="M8 15h8" /></>,
    alert: <><path d="M10.3 4.3 2.7 17.5A2 2 0 0 0 4.4 20h15.2a2 2 0 0 0 1.7-2.5L13.7 4.3a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 3h.01" /></>,
    spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" /></>,
    users: <><path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20" /><circle cx="9.5" cy="7" r="4" /><path d="M20.5 20v-1.5a4 4 0 0 0-3-3.9M16.5 3.2a4 4 0 0 1 0 7.6" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.5-1.7-.6a8 8 0 0 1-1.6.9l-.3 1.8h-2.9l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.6L8 16.2 9.4 15a7 7 0 0 1 0-1.9L8 12l1.4-2.5 1.7.6a8 8 0 0 1 1.6-.9l.3-1.8h2.9l.3 1.8a8 8 0 0 1 1.6.9l1.7-.6 1.4 2.5-1.4 1.1a7 7 0 0 1-.1 1.9Z" transform="translate(-1 -1) scale(.96)" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    dots: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01m4-9h6m-6 9h6" /></>,
    x: <><path d="m18 6-12 12M6 6l12 12" /></>,
    external: <><path d="M14 4h6v6m0-6-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  };
  return <svg {...shared}>{paths[name]}</svg>;
}

function StatusPill({ status }: { status: Status }) {
  const className = status === "Operacional" ? "status-pill is-up" : status === "Degradado" ? "status-pill is-warn" : status === "Pendente" ? "status-pill is-pending" : "status-pill is-down";
  return <span className={className}><i />{status}</span>;
}

function AddMonitorDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string, url: string) => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") || "").trim();
    const rawUrl = String(data.get("url") || "").trim();
    try {
      const parsed = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      if (!name || !parsed.hostname) throw new Error();
      setBusy(true);
      setError("");
      await onAdd(name, parsed.toString());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível adicionar o monitor.");
    } finally {
      setBusy(false);
    }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
      <div className="modal-head"><div><h2 id="add-title">Adicionar serviço</h2><p>Comece a acompanhar a disponibilidade de um endpoint.</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="x" /></button></div>
      <form onSubmit={submit} className="monitor-form">
        <label>Nome do serviço<input name="name" placeholder="Ex.: Payments API" autoFocus required maxLength={70} /></label>
        <label>URL do endpoint<input name="url" placeholder="https://api.exemplo.com/health" required maxLength={300} /></label>
        <div className="form-note"><Icon name="alert" size={15} /> O worker valida o destino antes de cada verificação e bloqueia redes privadas para prevenir SSRF.</div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>Cancelar</button><button type="submit" className="button button-primary" disabled={busy}><Icon name="plus" size={16} /> {busy ? "Adicionando…" : "Adicionar serviço"}</button></div>
      </form>
    </section>
  </div>;
}

function AuthDialog({ onClose, onAuthenticated }: { onClose: () => void; onAuthenticated: (session: Session) => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const input = mode === "register"
      ? { name: String(form.get("name") || ""), organizationName: String(form.get("organizationName") || ""), email: String(form.get("email") || ""), password: String(form.get("password") || "") }
      : { email: String(form.get("email") || ""), password: String(form.get("password") || "") };
    try {
      const session = await apiRequest<Session>(`/auth/${mode === "register" ? "register" : "login"}`, { method: "POST", body: JSON.stringify(input) });
      onAuthenticated(session);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível autenticar.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <div className="modal-head"><div><h2 id="auth-title">{mode === "register" ? "Crie sua conta" : "Boas-vindas de volta"}</h2><p>{mode === "register" ? "Sua organização será criada junto com a conta." : "Entre para acessar os dados da sua organização."}</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="x" /></button></div>
      <form onSubmit={submit} className="monitor-form">
        {mode === "register" && <>
          <label>Seu nome<input name="name" placeholder="Mariana Costa" required minLength={2} maxLength={80} autoFocus /></label>
          <label>Nome da organização<input name="organizationName" placeholder="Acme Inc." required minLength={2} maxLength={100} /></label>
        </>}
        <label>E-mail<input name="email" type="email" placeholder="voce@empresa.com" required maxLength={254} autoFocus={mode === "login"} /></label>
        <label>Senha<input name="password" type="password" placeholder="Mínimo de 12 caracteres" required minLength={mode === "register" ? 12 : 1} maxLength={128} /></label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); }}>{mode === "register" ? "Já tenho conta" : "Criar conta"}</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? "Aguarde…" : mode === "register" ? "Criar conta" : "Entrar"}</button></div>
      </form>
    </section>
  </div>;
}

function MonitorDetailDialog({
  monitor,
  history,
  historyLoading,
  historyError,
  actionError,
  actionMessage,
  busy,
  canWrite,
  onClose,
  onRefresh,
  onCheckNow,
  onToggle,
  onDelete,
}: {
  monitor: Monitor;
  history: MonitorCheck[];
  historyLoading: boolean;
  historyError: string;
  actionError: string;
  actionMessage: string;
  busy: boolean;
  canWrite: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onCheckNow: () => Promise<void>;
  onToggle: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal monitor-detail-modal" role="dialog" aria-modal="true" aria-labelledby="monitor-detail-title">
      <div className="modal-head"><div><h2 id="monitor-detail-title">{monitor.name}</h2><p>{monitor.url}</p></div><button className="icon-button" onClick={onClose} aria-label="Fechar" disabled={busy}><Icon name="x" /></button></div>
      <div className="monitor-detail-overview">
        <StatusPill status={monitor.status} />
        <span>Intervalo: <b>{monitor.intervalSec ?? 60} s</b></span>
        <span>Disponibilidade 24h: <b>{monitor.uptime}</b></span>
        <span>Última latência: <b>{monitor.latency}</b></span>
      </div>
      <div className="monitor-detail-actions">
        <button className="button button-primary" onClick={() => void onCheckNow()} disabled={busy || !monitor.isActive || !canWrite}><Icon name="pulse" size={15} /> Verificar agora</button>
        <button className="button button-secondary" onClick={() => void onToggle()} disabled={busy || !canWrite}><Icon name="clock" size={15} /> {monitor.isActive ? "Pausar" : "Retomar"}</button>
        <button className="button button-danger" onClick={() => setConfirmDelete(true)} disabled={busy || !canWrite}><Icon name="x" size={15} /> Excluir</button>
      </div>
      {!canWrite && <p className="history-permission-note">Seu papel nesta organização permite apenas visualizar os monitores.</p>}
      {actionMessage && <p className="action-message" role="status">{actionMessage}</p>}
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {confirmDelete && <div className="delete-confirm"><span><b>Excluir este monitor?</b><small>O histórico e os incidentes associados também serão removidos.</small></span><button className="button button-quiet" onClick={() => setConfirmDelete(false)} disabled={busy}>Cancelar</button><button className="button button-danger" onClick={() => void onDelete()} disabled={busy}>{busy ? "Excluindo…" : "Confirmar exclusão"}</button></div>}
      <section className="history-section" aria-labelledby="monitor-history-title">
        <div className="history-heading"><div><h3 id="monitor-history-title">Histórico de verificações</h3><p>Resultados mais recentes deste endpoint</p></div><button className="button button-secondary history-refresh" onClick={() => void onRefresh()} disabled={historyLoading}><Icon name="clock" size={14} /> Atualizar</button></div>
        {historyLoading ? <div className="history-state" role="status">Carregando histórico…</div> : historyError ? <div className="history-state is-error" role="alert">{historyError}</div> : history.length === 0 ? <div className="history-state">Ainda não há verificações registradas. A primeira execução pode levar alguns segundos.</div> : <div className="history-table-wrap"><table className="history-table"><thead><tr><th>RESULTADO</th><th>HORÁRIO</th><th>HTTP</th><th>LATÊNCIA</th><th>DETALHE</th></tr></thead><tbody>{history.map((check) => <tr key={check.id}><td><span className={`history-result ${check.success ? "is-success" : "is-failure"}`}><i />{check.success ? "Sucesso" : "Falhou"}</span></td><td>{new Date(check.checkedAt).toLocaleString("pt-BR")}</td><td>{check.statusCode ?? "—"}</td><td>{check.latencyMs} ms</td><td className="history-error" title={check.error ?? undefined}>{check.error ?? "—"}</td></tr>)}</tbody></table></div>}
      </section>
    </section>
  </div>;
}

export default function Dashboard() {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [view, setView] = useState("Visão geral");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Status | "Todos">("Todos");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [scenarioCreateOpen, setScenarioCreateOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>("checking");
  const [startupReady, setStartupReady] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceSummary | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [openIncidents, setOpenIncidents] = useState<Incident[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [emailAlertsEnabled, setEmailAlertsEnabled] = useState(false);
  const [emailDeliveryConfigured, setEmailDeliveryConfigured] = useState(false);
  const [emailAlertsSaving, setEmailAlertsSaving] = useState(false);
  const [notificationStreamState, setNotificationStreamState] = useState<NotificationStreamState>("connecting");
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationError, setNotificationError] = useState("");
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [availabilityHistory, setAvailabilityHistory] = useState<AvailabilityPoint[]>([]);
  const [dateLabel, setDateLabel] = useState("");
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | null>(null);
  const [monitorHistory, setMonitorHistory] = useState<MonitorCheck[]>([]);
  const historyRequestId = useRef(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [monitorActionBusy, setMonitorActionBusy] = useState(false);
  const [monitorActionError, setMonitorActionError] = useState("");
  const [monitorActionMessage, setMonitorActionMessage] = useState("");

  async function refreshLiveWorkspace() {
    setWorkspaceState("loading");
    setWorkspaceError("");
    try {
      const snapshot = await fetchWorkspaceSnapshot();
      setMonitors(snapshot.monitors);
      setWorkspaceSummary(snapshot.summary);
      setIncidents(snapshot.incidents);
      setOpenIncidents(snapshot.openIncidents);
      setNotifications(snapshot.notifications.items);
      setUnreadNotificationCount(snapshot.notifications.unreadCount);
      setEmailAlertsEnabled(snapshot.notifications.emailPreferences.emailAlertsEnabled);
      setEmailDeliveryConfigured(snapshot.notifications.emailPreferences.deliveryConfigured);
      setNotificationError("");
      setAvailabilityHistory(snapshot.availability.points);
      setWorkspaceState("live");
    } catch (failure) {
      setMonitors([]);
      setWorkspaceSummary(null);
      setIncidents([]);
      setOpenIncidents([]);
      setNotifications([]);
      setUnreadNotificationCount(0);
      setAvailabilityHistory([]);
      setWorkspaceState("error");
      setWorkspaceError(failure instanceof Error ? failure.message : "Não foi possível carregar os dados da organização.");
      throw failure;
    }
  }

  async function loadMonitorHistory(monitorId: string) {
    const requestId = ++historyRequestId.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const history = await apiRequest<MonitorCheck[]>(`/monitors/${encodeURIComponent(monitorId)}/history?limit=50`);
      if (requestId === historyRequestId.current) setMonitorHistory(history);
    } catch (failure) {
      if (requestId === historyRequestId.current) setHistoryError(failure instanceof Error ? failure.message : "Não foi possível carregar o histórico.");
    } finally {
      if (requestId === historyRequestId.current) setHistoryLoading(false);
    }
  }

  function openMonitorDetails(monitorId: string) {
    setSelectedMonitorId(monitorId);
    setMonitorHistory([]);
    setMonitorActionError("");
    setMonitorActionMessage("");
    void loadMonitorHistory(monitorId);
  }

  useEffect(() => {
    setDateLabel(new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date()).toLocaleUpperCase("pt-BR"));
    let mounted = true;
    void apiRequest<Session>("/auth/me").then(async (currentSession) => {
      if (!mounted) return;
      setSession(currentSession);
      setWorkspaceState("loading");
      setWorkspaceError("");
      try {
        const snapshot = await fetchWorkspaceSnapshot();
        if (!mounted) return;
        setMonitors(snapshot.monitors);
        setWorkspaceSummary(snapshot.summary);
        setIncidents(snapshot.incidents);
        setOpenIncidents(snapshot.openIncidents);
        setNotifications(snapshot.notifications.items);
        setUnreadNotificationCount(snapshot.notifications.unreadCount);
        setEmailAlertsEnabled(snapshot.notifications.emailPreferences.emailAlertsEnabled);
        setEmailDeliveryConfigured(snapshot.notifications.emailPreferences.deliveryConfigured);
        setNotificationError("");
        setAvailabilityHistory(snapshot.availability.points);
        setWorkspaceState("live");
      } catch (failure) {
        if (!mounted) return;
        setMonitors([]);
        setWorkspaceSummary(null);
        setIncidents([]);
        setOpenIncidents([]);
        setNotifications([]);
        setUnreadNotificationCount(0);
        setAvailabilityHistory([]);
        setWorkspaceState("error");
        setWorkspaceError(failure instanceof Error ? failure.message : "Não foi possível carregar os dados da organização.");
      }
    }).catch((failure: unknown) => {
      if (!mounted) return;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        setSession(null);
        setMonitors(seedMonitors);
        setAvailabilityHistory(createDemoAvailabilityHistory());
        setWorkspaceState("demo");
        setWorkspaceError("");
        return;
      }
      setSession(null);
      setMonitors([]);
      setWorkspaceSummary(null);
      setIncidents([]);
      setOpenIncidents([]);
      setNotifications([]);
      setUnreadNotificationCount(0);
      setAvailabilityHistory([]);
      setWorkspaceState("error");
      setWorkspaceError(failure instanceof Error ? failure.message : "Não foi possível verificar a sessão.");
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (workspaceState === "demo" || workspaceState === "live" || workspaceState === "error") {
      setStartupReady(true);
    }
  }, [workspaceState]);

  useEffect(() => {
    if (!session) return;
    let mounted = true;
    const refreshNotifications = async () => {
      try {
        const snapshot = await apiRequest<NotificationSnapshot>("/notifications");
        if (!mounted) return;
        setNotifications(snapshot.items);
        setUnreadNotificationCount(snapshot.unreadCount);
        setEmailAlertsEnabled(snapshot.emailPreferences.emailAlertsEnabled);
        setEmailDeliveryConfigured(snapshot.emailPreferences.deliveryConfigured);
        setNotificationError("");
      } catch (failure) {
        if (mounted) setNotificationError(failure instanceof Error ? failure.message : "Não foi possível atualizar as notificações.");
      }
    };
    const refreshWorkspace = async () => {
      try {
        const snapshot = await fetchWorkspaceSnapshot();
        if (!mounted) return;
        setMonitors(snapshot.monitors);
        setWorkspaceSummary(snapshot.summary);
        setIncidents(snapshot.incidents);
        setOpenIncidents(snapshot.openIncidents);
        setAvailabilityHistory(snapshot.availability.points);
        setNotifications(snapshot.notifications.items);
        setUnreadNotificationCount(snapshot.notifications.unreadCount);
        setEmailAlertsEnabled(snapshot.notifications.emailPreferences.emailAlertsEnabled);
        setEmailDeliveryConfigured(snapshot.notifications.emailPreferences.deliveryConfigured);
        setWorkspaceState("live");
        setWorkspaceError("");
        setNotificationError("");
      } catch (failure) {
        if (mounted) setNotificationError(failure instanceof Error ? failure.message : "Não foi possível atualizar as notificações.");
      }
    };
    const source = new EventSource(`${API_BASE}/notifications/stream`, { withCredentials: true });
    source.onopen = () => {
      setNotificationStreamState("connected");
      void refreshNotifications();
    };
    source.onmessage = () => void refreshWorkspace();
    source.onerror = () => setNotificationStreamState("reconnecting");
    const timer = window.setInterval(() => void refreshNotifications(), 60_000);
    return () => { mounted = false; source.close(); window.clearInterval(timer); };
  }, [session?.user.id, session?.organization.id]);

  useEffect(() => {
    if (view !== "Incidentes" || !selectedIncidentId) return;
    document.getElementById(`incident-${selectedIncidentId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [view, selectedIncidentId]);

  useEffect(() => {
    if (!notificationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNotificationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [notificationOpen]);

  async function updateEmailAlerts(enabled: boolean) {
    setEmailAlertsSaving(true);
    setNotificationError("");
    try {
      const preference = await apiRequest<{ emailAlertsEnabled: boolean; deliveryConfigured: boolean }>("/notifications/email-preferences", {
        method: "PATCH",
        body: JSON.stringify({ emailAlertsEnabled: enabled }),
      });
      setEmailAlertsEnabled(preference.emailAlertsEnabled);
      setEmailDeliveryConfigured(preference.deliveryConfigured);
    } catch (failure) {
      setNotificationError(failure instanceof Error ? failure.message : "Não foi possível atualizar os avisos por e-mail.");
    } finally {
      setEmailAlertsSaving(false);
    }
  }

  async function markNotificationRead(notification: Notification) {
    setNotificationOpen(false);
    if (notification.kind === "INCIDENT") {
      setView("Incidentes");
      setSelectedIncidentId(notification.event.incident.id);
    } else {
      setView("Testes de API");
    }
    if (notification.readAt) return;
    try {
      await apiRequest(`/notifications/${encodeURIComponent(notification.id)}/read`, { method: "PATCH" });
      setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item));
      setUnreadNotificationCount((count) => Math.max(0, count - 1));
      setNotificationError("");
    } catch (failure) {
      setNotificationError(failure instanceof Error ? failure.message : "Não foi possível marcar a notificação como lida.");
      setNotificationOpen(true);
    }
  }

  async function markAllNotificationsRead() {
    if (!unreadNotificationCount) return;
    try {
      await apiRequest("/notifications/read-all", { method: "PATCH" });
      const readAt = new Date().toISOString();
      setNotifications((items) => items.map((item) => ({ ...item, readAt: item.readAt ?? readAt })));
      setUnreadNotificationCount(0);
      setNotificationError("");
    } catch (failure) {
      setNotificationError(failure instanceof Error ? failure.message : "Não foi possível marcar as notificações como lidas.");
    }
  }

  async function logout() {
    try { await apiRequest("/auth/logout", { method: "POST" }); } catch { /* Clear the local workspace even if the API is offline. */ }
    setSession(null);
    setWorkspaceSummary(null);
    setIncidents([]);
    setOpenIncidents([]);
    setNotifications([]);
    setUnreadNotificationCount(0);
    setNotificationOpen(false);
    setMonitors(seedMonitors);
    setAvailabilityHistory(createDemoAvailabilityHistory());
    setWorkspaceState("demo");
    setWorkspaceError("");
    setSelectedMonitorId(null);
    historyRequestId.current += 1;
    setMonitorHistory([]);
    setHistoryLoading(false);
  }

  async function addMonitor(name: string, url: string) {
    try {
      await apiRequest("/monitors", { method: "POST", body: JSON.stringify({ name, url, intervalSec: 60 }) });
      await refreshLiveWorkspace();
      setDialogOpen(false);
      setView("Observabilidade");
    } catch (failure) {
      throw new Error(failure instanceof Error ? failure.message : "Não foi possível criar o monitor.");
    }
  }

  async function checkMonitorNow(monitorId: string) {
    setMonitorActionBusy(true);
    setMonitorActionError("");
    setMonitorActionMessage("");
    try {
      await apiRequest(`/monitors/${encodeURIComponent(monitorId)}/check`, { method: "POST" });
      setMonitorActionMessage("Verificação enviada para a fila. O resultado aparecerá no histórico em instantes.");
      await refreshLiveWorkspace();
      await loadMonitorHistory(monitorId);
    } catch (failure) {
      setMonitorActionError(failure instanceof Error ? failure.message : "Não foi possível iniciar a verificação.");
    } finally {
      setMonitorActionBusy(false);
    }
  }

  async function toggleMonitor(monitor: Monitor) {
    setMonitorActionBusy(true);
    setMonitorActionError("");
    setMonitorActionMessage("");
    try {
      await apiRequest(`/monitors/${encodeURIComponent(String(monitor.id))}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !monitor.isActive }),
      });
      setMonitorActionMessage(monitor.isActive ? "Monitor pausado." : "Monitor retomado.");
      await refreshLiveWorkspace();
    } catch (failure) {
      setMonitorActionError(failure instanceof Error ? failure.message : "Não foi possível atualizar o monitor.");
    } finally {
      setMonitorActionBusy(false);
    }
  }

  async function deleteMonitor(monitorId: string) {
    setMonitorActionBusy(true);
    setMonitorActionError("");
    try {
      await apiRequest(`/monitors/${encodeURIComponent(monitorId)}`, { method: "DELETE" });
      setSelectedMonitorId(null);
      historyRequestId.current += 1;
      setMonitorHistory([]);
      setHistoryLoading(false);
      await refreshLiveWorkspace();
    } catch (failure) {
      setMonitorActionError(failure instanceof Error ? failure.message : "Não foi possível excluir o monitor.");
    } finally {
      setMonitorActionBusy(false);
    }
  }

  const isOverview = view === "Visão geral";
  const isIncidents = view === "Incidentes";
  const isObservability = view === "Observabilidade";
  const isScenarioView = view === "Testes de API";
  const incidentMonitors = useMemo(() => monitors.filter((monitor) => {
    if (!session) return monitor.status === "Degradado" || monitor.status === "Incidente";
    return openIncidents.some((incident) =>
      incident.monitor.name.trim().toLowerCase() === monitor.name.trim().toLowerCase()
      || normalizeMonitorAddress(incident.monitor.url) === normalizeMonitorAddress(monitor.url),
    );
  }), [monitors, openIncidents, session]);
  const visibleMonitors = isIncidents ? incidentMonitors : monitors;
  const serviceStatusSummary = (["Operacional", "Degradado", "Incidente", "Pendente"] as Status[]).map((status) => {
    const matching = monitors.filter((monitor) => monitor.status === status);
    const names = matching.slice(0, 2).map((monitor) => monitor.name).join(", ");
    return {
      status,
      count: matching.length,
      detail: matching.length === 0 ? "Nenhum serviço" : names + (matching.length > 2 ? " e mais " + (matching.length - 2) : ""),
    };
  });
  const filteredMonitors = useMemo(() => visibleMonitors.filter((monitor) => {
    const matchesQuery = `${monitor.name} ${monitor.url}`.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = statusFilter === "Todos" || monitor.status === statusFilter;
    return matchesQuery && matchesStatus;
  }), [visibleMonitors, query, statusFilter]);
  const selectedMonitor = selectedMonitorId ? monitors.find((monitor) => String(monitor.id) === selectedMonitorId) ?? null : null;
  const isDemo = workspaceState === "demo";
  const initials = session?.user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() ?? "NX";
  const availabilityValue = isDemo
    ? demoAvailability
    : workspaceSummary
    ? workspaceSummary.availabilityPercent === null ? "—" : workspaceSummary.availabilityPercent.toFixed(2).replace(".", ",")
    : "—";
  const latencyValue = isDemo
    ? String(demoLatencyMs)
    : workspaceSummary
    ? workspaceSummary.averageLatencyMs === null ? "—" : String(Math.round(workspaceSummary.averageLatencyMs))
    : "—";
  const checksValue = isDemo ? demoChecks : workspaceSummary ? formatCount(workspaceSummary.checks24h) : "—";
  const incidentValue = isDemo ? String(demoIncidentCount).padStart(2, "0") : workspaceSummary ? String(workspaceSummary.activeIncidents).padStart(2, "0") : "—";
  const planUsagePercent = isDemo ? (seedMonitors.length / 25) * 100 : workspaceSummary ? Math.min((workspaceSummary.activeMonitors / 25) * 100, 100) : null;
  const monitorCountLabel = isDemo || workspaceSummary ? String(visibleMonitors.length) : "—";
  const workspaceModeLabel = isDemo ? "Ambiente de demonstração" : workspaceState === "live" ? "Dados ao vivo" : workspaceState === "error" ? "Falha ao carregar" : "Conectando dados";
  const workspaceModeClass = isDemo ? "is-demo" : workspaceState === "live" ? "is-live" : workspaceState === "error" ? "is-error" : "is-loading";
  const footerStatus = isDemo ? "Dados demonstrativos" : workspaceState === "error" ? "Falha ao carregar dados" : workspaceState !== "live" ? "Atualizando status" : workspaceSummary?.activeIncidents === 0 ? "Nenhum incidente ativo" : `${workspaceSummary?.activeIncidents ?? 0} incidente${workspaceSummary?.activeIncidents === 1 ? "" : "s"} ativo${workspaceSummary?.activeIncidents === 1 ? "" : "s"}`;
  const footerStatusClass = isDemo ? "is-demo" : workspaceState === "error" ? "is-alert" : workspaceState !== "live" ? "is-loading" : workspaceSummary?.activeIncidents ? "is-alert" : "is-healthy";
  const populatedAvailability = availabilityHistory.flatMap((point) => point.availabilityPercent === null ? [] : [point.availabilityPercent]);
  const minimumAvailability = populatedAvailability.length ? Math.min(...populatedAvailability) : 98;
  const chartStep = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100].find((step) => 100 - step * 4 <= minimumAvailability) ?? 100;
  const chartFloor = 100 - chartStep * 4;
  const chartY = (availability: number) => ((100 - availability) / (100 - chartFloor)) * 190;
  const chartSegments: { x: number; y: number }[][] = [];
  let currentChartSegment: { x: number; y: number }[] = [];
  availabilityHistory.forEach((point, index) => {
    if (point.availabilityPercent === null) {
      if (currentChartSegment.length) chartSegments.push(currentChartSegment);
      currentChartSegment = [];
      return;
    }
    currentChartSegment.push({ x: ((index + 0.5) / Math.max(availabilityHistory.length, 1)) * 760, y: chartY(point.availabilityPercent) });
  });
  if (currentChartSegment.length) chartSegments.push(currentChartSegment);
  const chartPaths = chartSegments.filter((segment) => segment.length > 1).map((segment) => segment.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" "));
  const chartDots = availabilityHistory.flatMap((point, index) => point.availabilityPercent === null ? [] : [{
    at: point.at,
    x: ((index + 0.5) / Math.max(availabilityHistory.length, 1)) * 760,
    y: chartY(point.availabilityPercent),
    availabilityPercent: point.availabilityPercent,
    checks: point.checks,
  }]);
  const chartTickOffsets = [0, 4, 8, 12, 16, 20, 24];
  const chartTimeTicks = chartTickOffsets.map((hoursFromStart) => {
    const label = hoursFromStart === 24 ? "AGORA" : `-${24 - hoursFromStart}H`;
    return { left: `${(hoursFromStart / 24) * 100}%`, label, edge: hoursFromStart === 0 ? "start" : hoursFromStart === 24 ? "end" : "middle" };
  });
  const chartHasData = populatedAvailability.length > 0;
  const chartMessage = workspaceState === "error"
    ? workspaceError || "Não foi possível carregar a disponibilidade."
    : workspaceState === "checking" || workspaceState === "loading"
    ? "Carregando os dados de disponibilidade…"
    : workspaceState === "live" && !chartHasData
    ? "Ainda não há verificações armazenadas nesta janela."
    : null;

  return <>
  <div className="app-shell" aria-busy={!startupReady} aria-hidden={!startupReady || undefined} inert={!startupReady}>
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 36 36" fill="none">
            <defs>
              <linearGradient id="nexus-mark-gradient" x1="6" y1="29" x2="30" y2="7" gradientUnits="userSpaceOnUse">
                <stop stopColor="#8B3DFF" />
                <stop offset="1" stopColor="#28A9FF" />
              </linearGradient>
            </defs>
            <path d="M8 28V10.5c0-2.4 2.9-3.5 4.6-1.8L28 26V8" stroke="url(#nexus-mark-gradient)" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="brand-copy">
          <span className="brand-word">NEXUS</span>
          <span className="brand-tagline">Monitor. Teste. Automatize. Resolva.</span>
        </div>
      </div>
      <div className="workspace-switch"><span className="workspace-avatar">{session?.organization.name.charAt(0).toUpperCase() ?? "N"}</span><span className="workspace-copy"><b>{session?.organization.name ?? "Nexus Cloud"}</b><small>{session ? session.organization.role : "AMBIENTE DE TESTE"}</small></span><span className="chevrons">⌃<br />⌄</span></div>
      <div className="nav-label">PLATAFORMA</div>
      <nav className="navigation" aria-label="Navegação principal">
        {navigation.map((item) => <div key={item.label}>
          {item.section && item.label !== "Visão geral" && <div className="nav-section-label">{item.section}</div>}
          <button aria-label={activeNavigation.has(item.label) ? item.label : `${item.label} (em breve)`} title={activeNavigation.has(item.label) ? item.label : `${item.label} - em breve`} disabled={!activeNavigation.has(item.label)} className={`nav-item ${view === item.label ? "active" : ""} ${activeNavigation.has(item.label) ? "" : "is-disabled"}`} onClick={() => { if (activeNavigation.has(item.label)) setView(item.label); }}><Icon name={item.icon} size={17} /><span>{item.label}</span>{!activeNavigation.has(item.label) && <small className="nav-coming-soon">Em breve</small>}{item.label === "Incidentes" && (session ? workspaceSummary?.activeIncidents : 1) ? <b className="nav-count">{session ? workspaceSummary?.activeIncidents : 1}</b> : null}</button>
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="plan-card"><div className="plan-card-top"><span>{isDemo ? "USO DO PLANO" : "MONITORES ATIVOS"}</span><span>{isDemo ? `${Math.round(planUsagePercent ?? 0)}%` : workspaceSummary?.activeMonitors ?? "—"}</span></div><div className="plan-track">{planUsagePercent !== null && <i style={{ width: `${planUsagePercent}%` }} />}</div><p>{isDemo ? `${seedMonitors.length} de 25 monitores utilizados` : workspaceSummary ? `${workspaceSummary.totalMonitors} serviços nesta organização` : workspaceState === "error" ? "Dados indisponíveis" : "Carregando uso do plano…"}</p><small className="plan-card-note">{isDemo ? "Dados de exemplo" : workspaceState === "live" ? "Limite do plano" : workspaceState === "error" ? "Verifique a conexão" : "Aguardando conexão"}</small></div>
        <div className="profile"><span className="profile-avatar">{initials}</span><span className="profile-copy"><b>{session?.user.name ?? "Operador Nexus"}</b><small>{session ? session.user.email : "ACESSO DE DEMONSTRAÇÃO"}</small></span></div>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumbs"><span>NEXUS / SISTEMA</span><b>/</b><strong>{view}</strong></div>
        <div className="topbar-actions">
          {session && <div className="notification-anchor">
            <button className="icon-button top-icon notification-button" onClick={() => setNotificationOpen((open) => !open)} aria-label={notificationOpen ? "Fechar notificações" : "Abrir notificações" + (unreadNotificationCount > 0 ? ", " + unreadNotificationCount + " não lidas" : "")} aria-expanded={notificationOpen} title="Notificações">
              <Icon name="bell" size={17} />
              {unreadNotificationCount > 0 && <span className="notification-count">{unreadNotificationCount > 9 ? "9+" : unreadNotificationCount}</span>}
            </button>
            {notificationOpen && <section className="notification-popover" aria-label="Notificações recentes">
              <div className="notification-popover-head"><div className="notification-head-copy"><span className={`notification-stream-status is-${notificationStreamState}`} aria-live="polite"><i />{notificationStreamState === "connected" ? "Tempo real ativo" : notificationStreamState === "reconnecting" ? "Reconectando" : "Conectando"}</span><b>Notificações</b></div><button className="icon-button" onClick={() => setNotificationOpen(false)} aria-label="Fechar notificações"><Icon name="x" size={16} /></button></div>
              <div className="notification-preference">
                <div><b>Avisos por e-mail</b><small>{emailDeliveryConfigured ? "Receba falhas e recuperações deste usuário." : "Configure RESEND_API_KEY e EMAIL_FROM para ativar."}</small></div>
                <label className="notification-toggle"><input type="checkbox" aria-label="Receber avisos por e-mail" checked={emailAlertsEnabled} disabled={!emailDeliveryConfigured || emailAlertsSaving} onChange={(event) => void updateEmailAlerts(event.currentTarget.checked)} /><span aria-hidden="true" /></label>
              </div>
              {unreadNotificationCount > 0 && <button className="notification-mark-all" onClick={() => void markAllNotificationsRead()}>Marcar todas como lidas</button>}
              {notificationError && <p className="notification-error" role="alert">{notificationError}</p>}
              {notifications.length === 0
                ? <div className="notification-empty"><span><Icon name="check" size={16} /></span><b>Nenhuma notificação recente</b><small>Os alertas de incidentes e cenários aparecem aqui.</small></div>
                : <div className="notification-list">{notifications.map((notification) => {
                  const failed = notification.kind === "INCIDENT" ? notification.event.type === "OPENED" : notification.run.status !== "PASSED";
                  const title = notification.kind === "INCIDENT"
                    ? notification.event.type === "OPENED" ? "Incidente aberto" : "Serviço recuperado"
                    : notification.run.status === "PASSED" ? "Cenário recuperado" : "Falha no cenário";
                  const detail = notification.kind === "INCIDENT"
                    ? `${notification.event.incident.monitor.name} · ${notification.event.incident.title}`
                    : `${notification.scenario.method} · ${notification.scenario.name}${notification.run.responseStatusCode ? ` · HTTP ${notification.run.responseStatusCode}` : ""}`;
                  const at = notification.kind === "INCIDENT" ? notification.event.createdAt : notification.createdAt;
                  return <button key={notification.id} className={notification.readAt ? "notification-item" : "notification-item is-unread"} onClick={() => void markNotificationRead(notification)}>
                  <span className={failed ? "notification-symbol is-alert" : "notification-symbol is-recovery"}><Icon name={failed ? "alert" : "check"} size={15} /></span>
                  <span className="notification-item-copy"><span><b>{title}</b><time>{formatRelativeTime(at)}</time></span><small>{detail}</small></span>
                  {!notification.readAt && <i className="notification-unread-dot" />}
                </button>})}</div>}
            </section>}
          </div>}
          {session ? <button className="sign-out-button" onClick={() => void logout()}>Sair</button> : <button className="button button-secondary auth-action" onClick={() => setAuthOpen(true)}>Entrar</button>}
          <span className="top-divider" /><span className="top-avatar">{initials}</span>
        </div>
      </header>
      <div className="page-content">
        {isScenarioView ? <>
          <div className="page-heading scenario-page-heading"><div><div className="page-title-row"><h1>Testes de API</h1>{session && <span className="workspace-badge is-live"><i />{session.organization.slug}</span>}</div><p>Execute requisições salvas e compare cada resposta com o contrato esperado.</p></div><div className="heading-actions">{!session ? <button className="button button-primary" onClick={() => setAuthOpen(true)}>Entrar</button> : session.organization.role !== "VIEWER" ? <button className="button button-primary" onClick={() => setScenarioCreateOpen(true)}><Icon name="plus" size={17} /> Novo cenário</button> : <span className="scenario-readonly-label">Acesso de leitura</span>}</div></div>
          <ApiScenarioWorkspace session={session} createOpen={scenarioCreateOpen} onCreateOpen={() => setScenarioCreateOpen(true)} onCreateClose={() => setScenarioCreateOpen(false)} onSignIn={() => setAuthOpen(true)} />
          <footer className="page-footer"><span>© 2026 NEXUS Systems</span><div><span className="footer-live"><i />Execuções sob demanda</span></div></footer>
        </> : <>
        <div className="page-heading">
          <div>
            <div className="page-title-row">
              <h1>{isIncidents ? "Incidentes" : isObservability ? "Observabilidade" : "Visão geral"}</h1>
              <span className={"workspace-badge " + workspaceModeClass} title={workspaceError || undefined}><i />{workspaceModeLabel}</span>
            </div>
            <p>{workspaceState === "error"
              ? workspaceError || "Não foi possível carregar os dados da organização."
              : workspaceState === "checking" || workspaceState === "loading"
              ? "Aguardando sinais dos serviços monitorados."
              : isIncidents
              ? "Falhas detectadas e recuperações confirmadas, em ordem cronológica."
              : isObservability
              ? "Disponibilidade, latência e verificações por serviço nas últimas 24 horas."
              : "Estado atual dos serviços, indicadores e incidentes recentes."}</p>
          </div>
          <div className="heading-actions">
            {!isIncidents && <span title={dateLabel || undefined} className="time-range"><Icon name="clock" size={15} /> 24H / {dateLabel || "JANELA ATUAL"}</span>}
            <button className="button button-primary" onClick={() => session ? setDialogOpen(true) : setAuthOpen(true)}><Icon name="plus" size={17} /> {session ? "Adicionar monitor" : "Criar conta"}</button>
          </div>
        </div>

        {(isOverview || isObservability) && <section className={"content-grid " + (isObservability ? "is-observability" : "overview-grid")}>
          {isObservability && <article className="panel uptime-panel">
            <div className="panel-heading"><div><h2>Disponibilidade</h2><p>Janela operacional · últimas 24 horas</p></div><span className="chart-scope"><i /> TODOS OS SERVIÇOS</span></div>
            <div className="chart-wrap">
              <div className="chart-y">{Array.from({ length: 5 }, (_, index) => <span key={index}>{(100 - chartStep * index).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%</span>)}</div>
              <div className="chart-main">
                <div className="chart-grid"><i /><i /><i /><i /><i /></div>
                <svg viewBox="0 0 760 190" preserveAspectRatio="none" className="uptime-chart" role="img" aria-label={`${isDemo ? "Disponibilidade demonstrativa" : "Disponibilidade registrada"} nas últimas 24 horas, com meta de 99,9%`}>
                  <line x1="0" y1={chartY(99.9)} x2="760" y2={chartY(99.9)} stroke="#f1bd6c" strokeDasharray="5 6" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
                  {chartPaths.map((path, index) => <path key={index} d={path} fill="none" stroke="#69edbd" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
                  {chartDots.map((point) => <circle key={point.at} cx={point.x} cy={point.y} r="2.3" fill="#69edbd" stroke="#0f1b20" strokeWidth="1.5" vectorEffect="non-scaling-stroke"><title>{`${new Date(point.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} · ${point.availabilityPercent.toFixed(2).replace(".", ",")}% · ${point.checks} verificações`}</title></circle>)}
                </svg>
                <div className="chart-x">{chartTimeTicks.map((tick) => <span key={tick.left} className={`is-${tick.edge}`} style={{ left: tick.left }}>{tick.label}</span>)}</div>
              </div>
              {chartMessage && <div className={`chart-placeholder-message ${workspaceState === "error" ? "is-error" : ""}`} role={workspaceState === "error" ? "alert" : "status"}>{chartMessage}</div>}
            </div>
            <div className="chart-legend"><span><i className="legend-purple" />Disponibilidade</span><span><i className="legend-dash" />Meta de 99,9%</span><small>{isDemo ? "AMOSTRA / DEMONSTRAÇÃO" : workspaceState === "live" ? "VERIFICAÇÕES ARMAZENADAS" : workspaceState === "error" ? "DADOS INDISPONÍVEIS" : "AGUARDANDO CONEXÃO"}</small></div>
          </article>}

          {isOverview && <article className="panel service-status-panel">
            <div className="panel-heading">
              <div><h2>Estado dos serviços</h2><p>Selecione um status para abrir os monitores correspondentes.</p></div>
              <button className="text-link" onClick={() => { setQuery(""); setStatusFilter("Todos"); setView("Observabilidade"); }}>Ver observabilidade <Icon name="arrow" size={15} /></button>
            </div>
            {workspaceState === "error"
              ? <div className="service-status-state is-error" role="alert">{workspaceError || "Não foi possível carregar o estado dos serviços."}</div>
              : workspaceState === "checking" || workspaceState === "loading"
              ? <div className="service-status-state" role="status">Carregando o estado dos serviços…</div>
              : monitors.length === 0
              ? <div className="service-status-state is-empty"><b>Nenhum monitor cadastrado</b><small>Adicione um serviço para começar a acompanhar disponibilidade e latência.</small><button className="text-link" onClick={() => session ? setDialogOpen(true) : setAuthOpen(true)}>{session ? "Adicionar monitor" : "Entrar para cadastrar"} <Icon name="arrow" size={15} /></button></div>
              : <div className="service-status-list" aria-label="Serviços por status">
                {serviceStatusSummary.map((item) => <button
                  key={item.status}
                  className={"service-status-row is-" + item.status.toLowerCase()}
                  disabled={item.count === 0}
                  aria-label={item.count === 0 ? item.status + ": nenhum serviço" : item.status + ": " + item.count + (item.count === 1 ? " serviço, abrir na observabilidade" : " serviços, abrir na observabilidade")}
                  onClick={() => { setQuery(""); setStatusFilter(item.status); setView("Observabilidade"); }}
                >
                  <span className="service-status-dot"><i /></span>
                  <span className="service-status-name">{item.status}</span>
                  <span className="service-status-detail">{item.detail}</span>
                  <b className="service-status-count">{item.count}</b>
                </button>)}
              </div>}
          </article>}

          {isOverview && <article className="panel incidents-panel">
            <div className="panel-heading"><div><h2>Incidentes recentes</h2><p>Atividade que requer atenção</p></div><button className="text-link" onClick={() => setView("Incidentes")}>Abrir histórico <Icon name="arrow" size={15} /></button></div>
            {workspaceState === "error" ? <div className="incident-failure" role="alert">Não foi possível carregar os incidentes.</div>
              : workspaceState === "checking" || workspaceState === "loading" ? <div className="incident-loading" role="status">Carregando incidentes…</div>
                : isDemo && demoFeaturedIncident ? <div className="incident-current"><span className="incident-indicator"><i /></span><div className="incident-copy"><div><b>Latência elevada</b><span className="incident-open">Em andamento</span></div><p>{demoFeaturedIncident.name} · {demoFeaturedIncident.group}</p><small><Icon name="clock" size={13} /> Iniciado há 18 min</small></div></div>
                  : isDemo ? <div className="incident-empty"><span className="incident-empty-check"><Icon name="check" size={16} /></span><span><b>Nenhum incidente ativo</b><small>Seus serviços estão sem falhas abertas.</small></span></div>
                  : openIncidents[0] ? <div className="incident-current"><span className="incident-indicator"><i /></span><div className="incident-copy"><div><b>{openIncidents[0].title}</b><span className="incident-open">Em andamento</span></div><p>{openIncidents[0].monitor.name} · {session?.organization.name}</p><small><Icon name="clock" size={13} /> Iniciado {formatRelativeTime(openIncidents[0].startedAt)}</small></div></div>
                    : <div className="incident-empty"><span className="incident-empty-check"><Icon name="check" size={16} /></span><span><b>Nenhum incidente ativo</b><small>Seus serviços estão sem falhas abertas.</small></span></div>}
            <div className="incident-footer"><span><i /> {workspaceState === "live" ? `${openIncidents.length} incidente${openIncidents.length === 1 ? "" : "s"} ativo${openIncidents.length === 1 ? "" : "s"}` : isDemo ? `${demoIncidentCount} incidente${demoIncidentCount === 1 ? "" : "s"} ativo${demoIncidentCount === 1 ? "" : "s"}` : workspaceState === "error" ? "Dados indisponíveis" : "Atualizando"}</span>{isDemo && <span>Exemplo do produto</span>}</div>
          </article>}
        </section>}

        {(isOverview || isObservability) && <section className="metrics-grid" aria-label="Indicadores do workspace">
          <article className="metric-card"><div className="metric-top"><span>Disponibilidade média</span></div><div className="metric-value">{availabilityValue}{availabilityValue !== "—" && <span>%</span>}</div><div className="metric-bottom"><span className={`trend ${isDemo ? "positive" : "neutral"}`}>{isDemo ? "↗ 0,08%" : workspaceState === "live" ? "últimas 24h" : workspaceState === "error" ? "indisponível" : "atualizando"}</span><span>{isDemo ? "amostra de dados" : workspaceState === "live" ? "dados reais" : "sem dados disponíveis"}</span></div></article>
          <article className="metric-card"><div className="metric-top"><span>Latência média</span></div><div className="metric-value">{latencyValue}{latencyValue !== "—" && <span className="metric-unit">ms</span>}</div><div className="metric-bottom"><span className={`trend ${isDemo ? "positive" : "neutral"}`}>{isDemo ? "↘ 12 ms" : workspaceState === "live" ? "últimas 24h" : workspaceState === "error" ? "indisponível" : "atualizando"}</span><span>{isDemo ? "amostra de dados" : workspaceState === "live" ? "média das verificações" : "sem dados disponíveis"}</span></div></article>
          <article className="metric-card"><div className="metric-top"><span>Verificações realizadas</span></div><div className="metric-value">{checksValue}</div><div className="metric-bottom"><span className={`trend ${isDemo ? "positive" : "neutral"}`}>{isDemo ? "↗ 8,2%" : workspaceState === "live" ? "últimas 24h" : workspaceState === "error" ? "indisponível" : "atualizando"}</span><span>{isDemo ? "amostra de dados" : workspaceState === "live" ? "execuções persistidas" : "sem dados disponíveis"}</span></div></article>
          <article className="metric-card"><div className="metric-top"><span>Incidentes ativos</span></div><div className="metric-value">{incidentValue}</div><div className="metric-bottom"><span className="trend neutral">{isDemo ? `${demoIncidentCount} serviço${demoIncidentCount === 1 ? "" : "s"} degradado${demoIncidentCount === 1 ? "" : "s"}` : workspaceState === "live" ? `${workspaceSummary?.activeMonitors ?? 0} monitores ativos` : workspaceState === "error" ? "indisponível" : "atualizando"}</span><span>{isDemo ? `em ${monitors.length} serviços` : workspaceState === "live" ? "na organização" : "sem dados disponíveis"}{(isDemo || workspaceState === "live") && <span className="metric-status-dot" />}</span></div></article>
        </section>}


        {isIncidents && <IncidentAnalysis signedIn={Boolean(session)} workspaceReady={workspaceState === "live"} />}

        {isIncidents && <section className="panel timeline-panel" aria-labelledby="incident-timeline-title">
          <div className="timeline-heading">
            <div><h2 id="incident-timeline-title">Registro de incidentes</h2><p>Falhas detectadas e recuperações confirmadas pelos monitores.</p></div>
            {workspaceState === "live" && <span className="timeline-total">{incidents.length} registros</span>}
          </div>
          {isDemo ? <div className="timeline-state"><span className="timeline-state-mark"><Icon name="clock" size={16} /></span><span><b>Histórico conectado</b><small>Entre na sua organização para consultar a linha do tempo real.</small></span><em>Demonstração</em></div>
            : workspaceState === "error" ? <div className="timeline-state is-error" role="alert"><span className="timeline-state-mark"><Icon name="alert" size={16} /></span><span><b>Não foi possível carregar os eventos</b><small>{workspaceError || "Verifique a conexão com a API e tente novamente."}</small></span></div>
              : workspaceState === "checking" || workspaceState === "loading" ? <div className="timeline-state" role="status"><span className="timeline-state-mark"><Icon name="clock" size={16} /></span><span><b>Sincronizando eventos</b><small>Buscando o histórico mais recente da organização.</small></span></div>
                : incidents.length === 0 ? <div className="timeline-state is-clear"><span className="timeline-state-mark"><Icon name="check" size={16} /></span><span><b>Nenhum incidente registrado</b><small>A linha do tempo será atualizada quando um serviço falhar ou se recuperar.</small></span></div>
                  : <div className="incident-timeline-list">{incidents.map((incident) => <article id={"incident-" + incident.id} key={incident.id} className={selectedIncidentId === incident.id ? "incident-timeline-card is-selected" : "incident-timeline-card"}>
                    <div className="incident-timeline-card-head">
                      <div><span className={incident.status === "OPEN" ? "timeline-status is-open" : "timeline-status is-resolved"}><i />{incident.status === "OPEN" ? "Em andamento" : "Resolvido"}</span><h3>{incident.title}</h3><p>{incident.monitor.name} <span>·</span> {incident.monitor.url}</p></div>
                      <time title={new Date(incident.startedAt).toLocaleString("pt-BR")}>{new Date(incident.startedAt).toLocaleString("pt-BR", { dateStyle: "medium", timeStyle: "short" })}</time>
                    </div>
                    {incident.message && <p className="incident-timeline-summary">{incident.message}</p>}
                    <ol className="incident-event-list">{incident.events.map((event) => <li key={event.id} className={event.type === "OPENED" ? "is-open-event" : "is-resolved-event"}>
                      <span className="event-rail"><i /></span><div><div className="event-heading"><b>{event.type === "OPENED" ? "Falha detectada" : "Recuperação confirmada"}</b><time title={new Date(event.createdAt).toLocaleString("pt-BR")}>{new Date(event.createdAt).toLocaleString("pt-BR", { dateStyle: "medium", timeStyle: "short" })}</time></div><p>{event.message || (event.type === "OPENED" ? "O health check não recebeu uma resposta válida." : "O serviço voltou a responder.")}</p></div>
                    </li>)}</ol>
                  </article>)}</div>}
        </section>}

        {(isIncidents || isObservability) && <section className="panel services-panel"><div className="panel-heading services-heading"><div><h2>{isIncidents ? "Serviços afetados" : "Serviços monitorados"}<span className="count-badge">{monitorCountLabel}</span></h2><p>{isIncidents ? "Monitores com incidentes abertos" : "Estado atual e última verificação"}</p></div><div className="service-tools"><label className="search-field"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isIncidents ? "Buscar serviço afetado..." : "Buscar serviço..."} aria-label={isIncidents ? "Buscar serviço afetado" : "Buscar serviço"} /></label><select className="select-button filter-button" aria-label="Filtrar serviços por status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as Status | "Todos")}><option value="Todos">Todos os status</option><option value="Operacional">Operacional</option><option value="Degradado">Degradado</option><option value="Incidente">Incidente</option><option value="Pendente">Pendente</option></select></div></div>
          <div className="table-wrap" role="region" aria-label={isIncidents ? "Lista de serviços afetados" : "Lista de serviços monitorados"} tabIndex={0}><table><thead><tr><th>SERVIÇO</th><th>STATUS</th><th>DISPONIBILIDADE</th><th>LATÊNCIA</th><th>ÚLTIMA VERIFICAÇÃO</th><th /></tr></thead><tbody>{filteredMonitors.map((monitor) => <tr key={monitor.id}><td><div className="service-cell"><span className={`service-mark ${monitor.color}`}><Icon name="server" size={17} /></span><span><b>{monitor.name}</b><small>{monitor.url}</small></span></div></td><td><StatusPill status={monitor.status} /></td><td><div className="uptime-cell"><span>{monitor.uptime}</span></div></td><td className={monitor.status === "Degradado" ? "latency-warn" : "latency-value"}>{monitor.latency}</td><td className="checked-cell">{monitor.checked}</td><td><button className="icon-button row-more" onClick={() => session ? openMonitorDetails(String(monitor.id)) : setAuthOpen(true)} aria-label={`Abrir detalhes de ${monitor.name}`}><Icon name="dots" size={17} /></button></td></tr>)}</tbody></table>{filteredMonitors.length === 0 && <div className="empty-search">{workspaceState === "checking" || workspaceState === "loading" ? <span>Carregando os serviços monitorados…</span> : workspaceState === "error" ? <><span>Não foi possível carregar os serviços.</span>{workspaceError && <small>{workspaceError}</small>}</> : visibleMonitors.length === 0 ? <><span>{isIncidents ? "Nenhum serviço com incidente ativo." : "Nenhum monitor cadastrado nesta organização."}</span>{session && !isIncidents && <button className="text-link" onClick={() => setDialogOpen(true)}>Adicionar primeiro monitor <Icon name="arrow" size={15} /></button>}{isIncidents && <button className="text-link" onClick={() => { setQuery(""); setStatusFilter("Todos"); setView("Observabilidade"); }}>Ver todos os serviços <Icon name="arrow" size={15} /></button>}</> : <><span>Nenhum serviço corresponde aos filtros atuais.</span><button className="text-link" onClick={() => { setQuery(""); setStatusFilter("Todos"); }}>Limpar filtros</button></>}</div>}</div>
          <div className="table-footer"><span>{workspaceState === "checking" || workspaceState === "loading" ? "Carregando serviços…" : workspaceState === "error" ? "Dados indisponíveis" : <>Exibindo <b>{filteredMonitors.length}</b> de <b>{visibleMonitors.length}</b> serviços</>}</span>{isIncidents && <button className="text-link" onClick={() => { setQuery(""); setStatusFilter("Todos"); setView("Observabilidade"); }}>Ver todos os serviços <Icon name="arrow" size={15} /></button>}</div>
        </section>}
        <footer className="page-footer"><span>© 2026 NEXUS Systems</span><div><span className={`footer-live ${footerStatusClass}`}><i />{footerStatus}</span></div></footer>
        </>}
      </div>
    </main>
    {dialogOpen && session && <AddMonitorDialog onClose={() => setDialogOpen(false)} onAdd={addMonitor} />}
    {selectedMonitor && session && <MonitorDetailDialog
      monitor={selectedMonitor}
      history={monitorHistory}
      historyLoading={historyLoading}
      historyError={historyError}
      actionError={monitorActionError}
      actionMessage={monitorActionMessage}
      busy={monitorActionBusy}
      canWrite={session.organization.role !== "VIEWER"}
      onClose={() => { setSelectedMonitorId(null); historyRequestId.current += 1; setHistoryLoading(false); setMonitorActionError(""); setMonitorActionMessage(""); }}
      onRefresh={() => loadMonitorHistory(String(selectedMonitor.id))}
      onCheckNow={() => checkMonitorNow(String(selectedMonitor.id))}
      onToggle={() => toggleMonitor(selectedMonitor)}
      onDelete={() => deleteMonitor(String(selectedMonitor.id))}
    />}
    {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onAuthenticated={(authenticatedSession) => { setSession(authenticatedSession); setMonitors([]); setWorkspaceSummary(null); setIncidents([]); setOpenIncidents([]); setWorkspaceState("loading"); setWorkspaceError(""); setAuthOpen(false); void refreshLiveWorkspace().catch(() => undefined); }} />}
  </div>
  <StartupSplash ready={startupReady} />
  </>;
}
