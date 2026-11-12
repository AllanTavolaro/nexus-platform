CREATE TYPE "ApiScenarioMethod" AS ENUM ('GET', 'POST', 'PUT', 'PATCH', 'DELETE');
CREATE TYPE "ApiScenarioRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR');
CREATE TYPE "ScenarioAssertionType" AS ENUM ('STATUS_CODE', 'BODY_CONTAINS', 'RESPONSE_TIME_MS');

CREATE TABLE "ApiScenario" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "method" "ApiScenarioMethod" NOT NULL DEFAULT 'GET',
    "url" VARCHAR(2048) NOT NULL,
    "body" VARCHAR(5000),
    "assertions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApiScenario_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiScenarioRun" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "status" "ApiScenarioRunStatus" NOT NULL DEFAULT 'QUEUED',
    "requestSnapshot" JSONB NOT NULL,
    "assertionsSnapshot" JSONB NOT NULL,
    "assertionResults" JSONB,
    "responseStatusCode" INTEGER,
    "responseTimeMs" INTEGER,
    "responsePreview" VARCHAR(4000),
    "error" VARCHAR(1000),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ApiScenarioRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApiScenario_organizationId_updatedAt_idx" ON "ApiScenario"("organizationId", "updatedAt" DESC);
CREATE INDEX "ApiScenarioRun_scenarioId_queuedAt_idx" ON "ApiScenarioRun"("scenarioId", "queuedAt" DESC);
CREATE INDEX "ApiScenarioRun_status_queuedAt_idx" ON "ApiScenarioRun"("status", "queuedAt");

ALTER TABLE "ApiScenario" ADD CONSTRAINT "ApiScenario_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiScenarioRun" ADD CONSTRAINT "ApiScenarioRun_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "ApiScenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
