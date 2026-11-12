CREATE TYPE "IncidentEventType" AS ENUM ('OPENED', 'RESOLVED');

CREATE TABLE "IncidentEvent" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "type" "IncidentEventType" NOT NULL,
    "message" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncidentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IncidentNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncidentNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IncidentNotification_userId_eventId_key" ON "IncidentNotification"("userId", "eventId");
CREATE INDEX "IncidentEvent_incidentId_createdAt_idx" ON "IncidentEvent"("incidentId", "createdAt");
CREATE INDEX "IncidentNotification_userId_readAt_createdAt_idx" ON "IncidentNotification"("userId", "readAt", "createdAt" DESC);

ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentNotification" ADD CONSTRAINT "IncidentNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentNotification" ADD CONSTRAINT "IncidentNotification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "IncidentEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "IncidentEvent" ("id", "incidentId", "type", "message", "createdAt")
SELECT 'evt_open_' || "id", "id", 'OPENED'::"IncidentEventType", "message", "startedAt"
FROM "Incident";

INSERT INTO "IncidentEvent" ("id", "incidentId", "type", "message", "createdAt")
SELECT 'evt_resolved_' || "id", "id", 'RESOLVED'::"IncidentEventType", 'A successful health check confirmed service recovery.', "resolvedAt"
FROM "Incident"
WHERE "resolvedAt" IS NOT NULL;
