import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import type { Request, Response, NextFunction } from "express";
import { AppModule } from "./app.module";

loadEnv({ path: resolve(process.cwd(), "../../.env") });

async function bootstrap() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET.includes("replace-with")) {
    throw new Error("Set JWT_SECRET to a private random value with at least 32 characters in the root .env file.");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.SCENARIO_SECRET_KEY ?? "")) {
    throw new Error("Set SCENARIO_SECRET_KEY to a private 32-byte hexadecimal key in the root .env file.");
  }
  const configuredOrigins = process.env.WEB_ORIGIN?.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (process.env.NODE_ENV === "production") {
    if (!configuredOrigins?.length) {
      throw new Error("Set WEB_ORIGIN to the production web origin or origins before starting the API.");
    }
    for (const origin of configuredOrigins) {
      let parsedOrigin: URL;
      try { parsedOrigin = new URL(origin); }
      catch { throw new Error("WEB_ORIGIN must contain valid HTTPS origins separated by commas."); }
      if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin) {
        throw new Error("WEB_ORIGIN must contain valid HTTPS origins separated by commas.");
      }
    }
  }
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  const trustedProxyCidrs = process.env.TRUSTED_PROXY_CIDRS?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (trustedProxyCidrs.length) app.getHttpAdapter().getInstance().set("trust proxy", trustedProxyCidrs);
  app.enableCors({ origin: configuredOrigins?.length ? configuredOrigins : ["http://localhost:3000"], credentials: true });
  app.use(cookieParser());
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    const startedAt = process.hrtime.bigint();
    response.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      console.info(JSON.stringify({
        event: "http.request.completed",
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      }));
    });
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  const swaggerConfig = new DocumentBuilder()
    .setTitle("NEXUS API")
    .setDescription("NEXUS platform API")
    .setVersion("0.1.0")
    .addCookieAuth("nexus_session")
    .build();
  SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, swaggerConfig));
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
