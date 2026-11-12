import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { MembershipRole } from "@prisma/client";
import { compare, hash } from "bcryptjs";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { LoginDto, RegisterDto } from "./auth.dto";
import { SessionClaims, SessionUser, toSessionResponse } from "./session-user";

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  async register(input: RegisterDto) {
    const email = input.email.trim().toLowerCase();
    if (Buffer.byteLength(input.password, "utf8") > 72) {
      throw new BadRequestException("Password must be at most 72 UTF-8 bytes.");
    }
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ConflictException("An account with this email already exists.");
    }

    const passwordHash = await hash(input.password, 12);
    const slugBase = input.organizationName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "workspace";
    const slug = `${slugBase}-${randomBytes(3).toString("hex")}`;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { name: input.name, email, passwordHash },
          select: { id: true, name: true, email: true },
        });
        const organization = await tx.organization.create({
          data: { name: input.organizationName, slug },
        });
        const membership = await tx.membership.create({
          data: { userId: user.id, organizationId: organization.id, role: MembershipRole.OWNER },
        });
        return { user, organization, membership };
      });

      const sessionUser: SessionUser = {
        id: created.user.id,
        name: created.user.name,
        email: created.user.email,
        organizationId: created.organization.id,
        organizationName: created.organization.name,
        organizationSlug: created.organization.slug,
        role: created.membership.role,
      };
      return this.createSession(sessionUser);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ConflictException("An account with this email already exists.");
      throw error;
    }
  }

  async login(input: LoginDto) {
    if (Buffer.byteLength(input.password, "utf8") > 72) {
      throw new UnauthorizedException("Email or password is incorrect.");
    }
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.trim().toLowerCase() },
      include: { memberships: { include: { organization: true }, orderBy: { createdAt: "asc" } } },
    });
    if (!user || !(await compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException("Email or password is incorrect.");
    }
    const membership = user.memberships.find((entry) => entry.role === MembershipRole.OWNER) ?? user.memberships[0];
    if (!membership) throw new UnauthorizedException("No active organization is attached to this account.");

    return this.createSession({
      id: user.id,
      name: user.name,
      email: user.email,
      organizationId: membership.organizationId,
      organizationName: membership.organization.name,
      organizationSlug: membership.organization.slug,
      role: membership.role,
    });
  }

  private async createSession(user: SessionUser) {
    const claims: SessionClaims = { sub: user.id, organizationId: user.organizationId };
    const token = await this.jwt.signAsync(claims, { expiresIn: "7d" });
    return { token, session: toSessionResponse(user) };
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
}
