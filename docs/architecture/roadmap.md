# NEXUS MVP roadmap

The proposed 12-week plan is a planning estimate. Work should be accepted by outcomes, not calendar dates.

## Milestone 1 — Foundation

- [x] Monorepo, local Docker services, and environment configuration
- [x] Modular NestJS API and independent worker process
- [x] PostgreSQL data model and initial migration workflow
- [x] Account, organization, membership, and role model
- [x] Initial security boundaries and architecture decisions documented

## Milestone 2 — Monitoring core

- [x] Authenticated monitor create, list, update, pause, and delete API flows
- [x] BullMQ scheduling, retry policy, and bounded worker concurrency
- [x] SSRF-safe HTTP checks with DNS pinning, no redirects, and request timeout
- [x] Persisted check history and availability/latency summaries
- [x] Dashboard monitor list, summary metrics, and incidents backed by organization-scoped API data
- [x] Historical availability chart backed by hourly aggregates of stored checks
- [x] Authenticated check history, manual check, pause/resume, and delete controls in the web UI

## Milestone 3 — Incidents and testing

- [x] Basic incident open/resolve rules
- [x] Persisted incident event timeline and per-user in-app notifications
- [x] API request scenarios with response assertions and manual run history
- [x] Scheduled test runs with bounded intervals and pause/resume
- [x] Encrypted API credential vault and authenticated scenario headers
- [x] In-app and optional Slack alerts on scenario failure and recovery
- [x] Realtime notification updates over authenticated SSE backed by Redis pub/sub
- [x] Optional Resend email adapter with queued delivery and per-user opt-in

## Milestone 4 — Production readiness

- [x] AI analysis grounded in stored evidence, with structured output
- [x] Focused unit coverage for SSRF validation, encrypted credentials, organization scoping, and viewer write access
- [x] CI pipeline for unit checks, database-backed smoke coverage, and production builds
- [x] Initial repository-level security review and deployment/backup runbook
- [x] Database-backed integration smoke coverage for registration, tenant isolation, credential redaction, and viewer permissions
- [x] Redis-shared rate limits for registration, login, and incident analysis
- [ ] Broader regression and E2E coverage, including queue failures and incident transitions
- [ ] Tracing, metrics, alerting, container image scanning, and worker health signal
- [x] npm audit and Dependabot dependency update checks
- [ ] Deployment, verified backup/restore drill, and public documentation

## MVP acceptance checklist

- [x] A user can register, sign in, and create an organization.
- [x] Organization-owned monitor, incident, and dashboard requests enforce tenant scoping; monitor mutations enforce write-role checks.
- [x] Users can register monitors and schedule health checks.
- [x] Workers execute checks outside HTTP request handling.
- [x] Dashboard summary metrics and monitor status come from persisted check data; history is available through the API.
- [x] Live availability chart shows 24 hourly buckets derived from persisted organization-scoped checks.
- [x] Failure opens an incident; recovery resolves it while preserving start and resolution timestamps.
- [x] Users can review incident opening and recovery events, receive organization-scoped notifications, and mark them as read.
- [x] Organization members can save API request scenarios, run them asynchronously, compare status/body/time assertions, and review saved response history.
- [x] Scenarios can run on a recurring schedule and send failure/recovery alerts in-app and to an optional Slack webhook.
- [x] Notification changes stream to connected dashboards; optional email alerts are queued only for users who opt in.
- [x] API credentials and Slack webhooks are encrypted at rest with a key stored outside the database; run history does not return request snapshots.
- [x] The monitor runner blocks non-public destinations and does not follow redirects.
- [x] The API scenario runner also blocks non-public destinations, avoids redirects, and bounds request time and response size.
- [ ] The deployed application, API documentation, CI, and runbook are accessible.
