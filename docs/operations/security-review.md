# Security review

Review date: 2026-11-12  
Review type: repository-level static review, focused unit tests, and a database-backed integration smoke run against local PostgreSQL and Redis. No external penetration test, successful hosted dependency audit, or production environment review was performed.

The local `npm audit` request could not reach the npm security endpoint in this environment. CI now runs the audit on its hosted runner; review its result before release.

## Controls verified in the repository

- API records are queried with the authenticated organization ID in the inspected monitor, dashboard, incident, scenario, notification, and credential flows.
- The session cookie is HTTP-only, uses `SameSite=Lax`, and is marked secure in production. CORS uses configured origins, and production startup now requires `WEB_ORIGIN`.
- Monitor and scenario workers reject non-HTTP(S) URLs, credentials in URLs, nonstandard ports, private or special-use DNS answers, and mixed public/private DNS results. HTTP clients validate DNS again at connect time and do not follow redirects.
- API and scenario credential values use AES-256-GCM with a random 96-bit IV and a separate authentication tag. Unit tests cover encryption round trips, IV uniqueness, missing keys, and target-address filtering.
- API request logs omit query strings and bodies. Worker logs use structured event names and avoid logging request headers or credential values.

## Required before a public launch

1. **Rate limiting for account and sensitive endpoints.** Registration, login, and incident analysis now use atomic Redis-backed limits; login has both IP and normalized-account buckets. CI verifies the login threshold. Configure the same Redis namespace on all API instances and set `TRUSTED_PROXY_CIDRS` to the exact ingress addresses when deployed behind a proxy. The cross-instance behavior still needs confirmation in the selected hosting environment.
2. **Automated dependency and image scanning.** CI now runs `npm audit --audit-level=high`, and Dependabot update checks are configured. Review the hosted audit result before release. Container image scanning is still needed when deployable images are introduced.
3. **Production observability.** Structured request and queue logs are present. Metrics, traces, alert rules, queue-lag monitoring, and a worker health signal are not implemented.
4. **Database-backed integration and E2E coverage.** A CI smoke suite now exercises authentication, tenant isolation across API requests, credential redaction, viewer write restrictions, and Redis rate limiting against PostgreSQL and Redis. Broader E2E coverage, queue failure recovery, and incident transition flows remain to be added.
5. **Deployment controls.** Select a hosting target, configure TLS and trusted proxy behavior, restrict database and Redis network access, and apply outbound network controls to worker workloads. The worker's URL filtering should remain enabled as a separate control.
6. **Recovery evidence.** Run and record a database restore drill, confirm encrypted backups and the credential key are recoverable, and set recovery time and recovery point objectives.

## Deployment boundaries

The local Compose file uses development credentials and publishes PostgreSQL and Redis ports. Use private managed services or a production-specific network configuration instead. Store all production secrets outside source control. Do not use the sample values in `.env.example` in a deployed environment.
