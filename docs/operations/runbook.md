# Operations runbook

This runbook covers a production deployment of the NEXUS API, web app, worker, PostgreSQL, and Redis. The repository does not include deployment manifests or a cloud-specific target, so adapt these steps to the selected hosting platform before launch.

## Required configuration

- Run Node.js 22.12 or newer and install from the committed lockfile with `npm ci`.
- Set `DATABASE_URL` and `REDIS_URL` to private service endpoints. Do not expose PostgreSQL or Redis to the public internet.
- Set `JWT_SECRET` to a private random value of at least 32 characters.
- Set `SCENARIO_SECRET_KEY` to 64 hexadecimal characters generated from 32 random bytes. Store an encrypted backup separately from database backups; losing or rotating this key without re-encrypting stored credentials makes those credentials unreadable.
- Set `WEB_ORIGIN` to the exact HTTPS origin of each deployed web app. The API now refuses to start in production without it.
- Set the same environment-specific `RATE_LIMIT_PREFIX` on every API instance in that environment. Use different prefixes if environments share one Redis service. If the API is behind a reverse proxy, set `TRUSTED_PROXY_CIDRS` to that ingress's exact IPs or CIDRs; leave it empty when the API receives client connections directly.
- Configure `API_PORT`, `NEXT_PUBLIC_API_URL`, and optional provider credentials (`OPENAI_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`) for the deployment.
- Terminate TLS at a trusted ingress or reverse proxy. Set secure cookies by running the API with `NODE_ENV=production`.

The root `docker-compose.yml` is for local development only. It uses local default credentials and publishes database and Redis ports; do not use it as a production deployment configuration.

## Release procedure

1. Review the CI workflow result for the release commit. CI installs locked dependencies, runs the npm vulnerability audit, generates Prisma Client, applies migrations to disposable PostgreSQL, runs unit and database-backed integration smoke checks with PostgreSQL and Redis, and builds all three workspaces.
2. Build and publish immutable API, worker, and web artifacts from the same commit using the hosting platform's deployment pipeline.
3. Take a database backup before schema changes.
4. Run `npm run db:migrate:deploy` once against the production database using the release artifact and production `DATABASE_URL`.
5. Deploy the API and worker, then the web app. Keep at least one previous artifact available for rollback.
6. Confirm `GET /api/health` returns HTTP 200 and `GET /api/health/ready` returns HTTP 200 with both `database` and `redis` set to `ok`.
7. Confirm worker logs show queue processing and run an operator-approved monitor check against a controlled public endpoint.
8. Watch API and worker error rates, queue lag, database capacity, Redis memory, and email/provider failures during the rollout.

For local verification, start PostgreSQL and Redis, apply migrations with `npm run db:migrate`, then run `npm run test:integration`. The smoke test creates temporary organizations and records, removes those database rows afterward, and uses `example.test` targets without sending external requests.

The API limits registration to 5 requests per IP per hour, login to 30 attempts per IP and 10 per account per 15 minutes, and incident analysis to 10 requests per IP per hour. Counters are atomic Redis windows shared across API instances. If Redis is unavailable, these protected routes return HTTP 503. The API emits one JSON `http.request.completed` event per request with method, path, status code, and duration. It does not log query strings or request bodies. Worker queue events are also JSON. Metrics, traces, alert thresholds, and a worker-specific health endpoint are still required for a production service-level objective.

## Database backup

Install PostgreSQL client tools and run the backup script from a host that can reach the database:

```sh
DATABASE_URL='postgresql://user:password@db.internal:5432/nexus?sslmode=require&schema=public' \
BACKUP_DIR='/var/backups/nexus' \
npm run db:backup
```

The script writes a custom-format `pg_dump` archive with restrictive local permissions and checks that `pg_restore` can read its catalog. Copy completed archives to encrypted off-host storage and apply a retention policy there. Keep the `SCENARIO_SECRET_KEY` backup separately in the organization's secret manager.

## Restore drill

Restore into a disposable PostgreSQL database first. The following command replaces objects with matching names in the target database:

```sh
pg_restore --clean --if-exists --no-owner --no-acl \
  --dbname="$RESTORE_DATABASE_URL" /path/to/nexus-backup.dump
```

Run the committed Prisma migrations after restoring if the archive predates the deployed schema. Verify account sign-in, monitor history, incident history, and scenario metadata. Confirm a saved credential can be used only when the separately backed up `SCENARIO_SECRET_KEY` is available. Record the restore duration and any data loss against the recovery objectives. Perform and record a restore drill before launch and at least quarterly.

## Incident response

- **API unavailable:** check API logs, `GET /api/health/ready`, PostgreSQL connectivity, Redis connectivity, and the latest migration result.
- **Checks stop running:** check worker process logs, Redis availability, BullMQ queue lag, and whether the worker is running the same release as the API.
- **Credentials fail to decrypt:** verify the configured `SCENARIO_SECRET_KEY` against the secret manager. Do not generate a replacement key over the existing one.
- **Unexpected monitor traffic:** pause the affected monitor or scenario, review its target URL and the worker's structured failure logs, and preserve relevant database records.
- **Suspected credential exposure:** rotate the affected API credential, Slack webhook, or provider key; review access to database and secret-manager audit logs.
