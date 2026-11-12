CREATE TYPE "ApiScenarioRunTrigger" AS ENUM ('MANUAL', 'SCHEDULED');
CREATE TYPE "ScenarioSecretType" AS ENUM ('API_CREDENTIAL', 'SLACK_WEBHOOK');

ALTER TABLE "ApiScenario"
  ADD COLUMN "headers" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "scheduleIntervalSec" INTEGER,
  ADD COLUMN "slackWebhookSecretId" TEXT;

ALTER TABLE "ApiScenarioRun"
  ADD COLUMN "queueJobId" TEXT,
  ADD COLUMN "trigger" "ApiScenarioRunTrigger" NOT NULL DEFAULT 'MANUAL';

CREATE TABLE "ScenarioSecret" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "type" "ScenarioSecretType" NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "iv" VARCHAR(32) NOT NULL,
  "authTag" VARCHAR(32) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScenarioSecret_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiScenarioNotification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scenarioId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiScenarioNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScenarioSecret_organizationId_name_key" ON "ScenarioSecret"("organizationId", "name");
CREATE INDEX "ScenarioSecret_organizationId_type_idx" ON "ScenarioSecret"("organizationId", "type");
CREATE UNIQUE INDEX "ApiScenarioRun_queueJobId_key" ON "ApiScenarioRun"("queueJobId");
CREATE INDEX "ApiScenarioNotification_userId_readAt_createdAt_idx" ON "ApiScenarioNotification"("userId", "readAt", "createdAt" DESC);
CREATE INDEX "ApiScenarioNotification_scenarioId_createdAt_idx" ON "ApiScenarioNotification"("scenarioId", "createdAt" DESC);
ALTER TABLE "ScenarioSecret" ADD CONSTRAINT "ScenarioSecret_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiScenario" ADD CONSTRAINT "ApiScenario_slackWebhookSecretId_fkey" FOREIGN KEY ("slackWebhookSecretId") REFERENCES "ScenarioSecret"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApiScenarioNotification" ADD CONSTRAINT "ApiScenarioNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiScenarioNotification" ADD CONSTRAINT "ApiScenarioNotification_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "ApiScenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiScenarioNotification" ADD CONSTRAINT "ApiScenarioNotification_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ApiScenarioRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ApiScenarioNotification_userId_runId_key" ON "ApiScenarioNotification"("userId", "runId");
