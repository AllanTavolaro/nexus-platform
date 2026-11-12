import { Injectable, MessageEvent, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Redis from "ioredis";
import { filter, interval, map, merge, Observable, Subject } from "rxjs";

type NotificationUpdate = { organizationId: string };

const NOTIFICATION_CHANNEL = "nexus:notification-events";

@Injectable()
export class NotificationsRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly subscriber = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { enableReadyCheck: false });
  private readonly publisher = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  private readonly updates = new Subject<NotificationUpdate>();

  async onModuleInit() {
    this.subscriber.on("error", () => undefined);
    this.subscriber.on("message", (channel, message) => {
      if (channel !== NOTIFICATION_CHANNEL) return;
      try {
        const update = JSON.parse(message) as Partial<NotificationUpdate>;
        if (typeof update.organizationId === "string") this.updates.next({ organizationId: update.organizationId });
      } catch {
        // Ignore malformed pub/sub messages; connected clients keep their fallback refresh.
      }
    });
    await this.subscriber.subscribe(NOTIFICATION_CHANNEL);
  }

  async onModuleDestroy() {
    this.updates.complete();
    await Promise.all([this.subscriber.quit(), this.publisher.quit()]);
  }

  async publishUpdate(organizationId: string) {
    try {
      await this.publisher.publish(NOTIFICATION_CHANNEL, JSON.stringify({ organizationId }));
    } catch {
      // The UI keeps a periodic refresh if the pub/sub connection is unavailable.
    }
  }

  stream(organizationId: string): Observable<MessageEvent> {
    const updates = this.updates.pipe(
      filter((update) => update.organizationId === organizationId),
      map(() => ({ data: { type: "notifications.updated" } })),
    );
    const heartbeats = interval(25_000).pipe(
      map(() => ({ type: "heartbeat", data: { sentAt: Date.now() } })),
    );
    return merge(updates, heartbeats);
  }
}
