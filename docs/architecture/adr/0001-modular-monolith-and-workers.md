# ADR 0001: Modular monolith with separate workers

- Status: Accepted
- Date: 2026-11-12

## Context

The first NEXUS release needs clear domain boundaries and background monitoring without the deployment and coordination cost of microservices.

## Decision

Build one modular NestJS API, one independently running worker application, and one Next.js web application. Use PostgreSQL as the source of truth and Redis/BullMQ for background jobs.

## Consequences

- Domain modules can evolve independently while sharing one API deployment.
- Monitoring work can scale separately from web requests.
- Queue processing must be idempotent, observable, and safe to retry.
- A later service split remains possible if operational needs justify it.

