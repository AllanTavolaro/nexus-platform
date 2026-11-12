import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { MembershipRole, Prisma, ScenarioSecretType } from "@prisma/client";
import { SessionUser } from "../auth/session-user";
import { PrismaService } from "../prisma/prisma.service";
import { CreateScenarioSecretDto, RotateScenarioSecretDto } from "./scenario-secrets.dto";
import { encryptScenarioSecret } from "./scenario-secrets.crypto";

@Injectable()
export class ScenarioSecretsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: SessionUser) {
    return this.prisma.scenarioSecret.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, type: true, createdAt: true, updatedAt: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });
  }

  async create(user: SessionUser, input: CreateScenarioSecretDto) {
    this.requireWriteAccess(user);
    const type = input.type as ScenarioSecretType;
    const value = this.validateValue(type, input.value);
    await this.ensureNameAvailable(user.organizationId, input.name);
    const encrypted = encryptScenarioSecret(value);
    return this.prisma.scenarioSecret.create({
      data: { organizationId: user.organizationId, name: input.name, type, ...encrypted },
      select: { id: true, name: true, type: true, createdAt: true, updatedAt: true },
    });
  }

  async rotate(user: SessionUser, id: string, input: RotateScenarioSecretDto) {
    this.requireWriteAccess(user);
    const secret = await this.findOwned(user.organizationId, id);
    if (input.name && input.name !== secret.name) await this.ensureNameAvailable(user.organizationId, input.name, id);
    const value = this.validateValue(secret.type, input.value);
    const encrypted = encryptScenarioSecret(value);
    return this.prisma.scenarioSecret.update({
      where: { id: secret.id },
      data: { ...(input.name ? { name: input.name } : {}), ...encrypted },
      select: { id: true, name: true, type: true, createdAt: true, updatedAt: true },
    });
  }

  async remove(user: SessionUser, id: string) {
    this.requireWriteAccess(user);
    const secret = await this.findOwned(user.organizationId, id);
    const scenarios = await this.prisma.apiScenario.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, slackWebhookSecretId: true, headers: true },
    });
    const referenced = scenarios.some((scenario) =>
      scenario.slackWebhookSecretId === secret.id ||
      (Array.isArray(scenario.headers) && scenario.headers.some((header) => isRecord(header) && header.secretId === secret.id)),
    );
    if (referenced) throw new ConflictException("Remove this credential from its scenarios before deleting it.");
    await this.prisma.scenarioSecret.delete({ where: { id: secret.id } });
    return { status: "deleted" };
  }

  async encryptedForScenario(organizationId: string, id: string, type: ScenarioSecretType) {
    const secret = await this.prisma.scenarioSecret.findFirst({
      where: { id, organizationId, type },
      select: { id: true, ciphertext: true, iv: true, authTag: true },
    });
    if (!secret) throw new BadRequestException("Choose a credential of the correct type from this organization.");
    return secret;
  }

  private async findOwned(organizationId: string, id: string) {
    const secret = await this.prisma.scenarioSecret.findFirst({ where: { id, organizationId } });
    if (!secret) throw new NotFoundException("Credential not found.");
    return secret;
  }

  private async ensureNameAvailable(organizationId: string, name: string, exceptId?: string) {
    const existing = await this.prisma.scenarioSecret.findFirst({ where: { organizationId, name, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (existing) throw new ConflictException("A credential with this name already exists.");
  }

  private validateValue(type: ScenarioSecretType, value: string) {
    if (type !== ScenarioSecretType.SLACK_WEBHOOK) {
      if (/[\r\n]/.test(value) || value.length > 2048) throw new BadRequestException("API credentials must be a single header value of at most 2048 characters.");
      return value;
    }
    let url: URL;
    try { url = new URL(value); } catch { throw new BadRequestException("Enter a valid Slack incoming webhook URL."); }
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || url.username || url.password || url.port || url.search || url.hash || !url.pathname.startsWith("/services/")) {
      throw new BadRequestException("Use an HTTPS Slack incoming webhook URL from hooks.slack.com.");
    }
    return url.toString();
  }

  private requireWriteAccess(user: SessionUser) {
    if (user.role === MembershipRole.VIEWER) throw new ForbiddenException("Your role cannot change scenario credentials.");
  }
}

function isRecord(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
