ALTER TYPE "ApiScenarioRunTrigger" ADD VALUE 'COLLECTION';

ALTER TABLE "ApiScenario"
  ADD COLUMN "collectionName" VARCHAR(80) NOT NULL DEFAULT 'Geral';

CREATE INDEX "ApiScenario_organizationId_collectionName_createdAt_idx"
  ON "ApiScenario"("organizationId", "collectionName", "createdAt");
