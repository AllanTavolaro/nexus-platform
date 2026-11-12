import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { SessionClaims, SessionUser } from "./session-user";

type RequestWithUser = Request & { user?: SessionUser; cookies?: Record<string, string> };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const bearer = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice("Bearer ".length)
      : undefined;
    const token = request.cookies?.nexus_session ?? bearer;
    if (!token) throw new UnauthorizedException("Sign in to continue.");

    let claims: SessionClaims;
    try {
      claims = await this.jwt.verifyAsync<SessionClaims>(token);
    } catch {
      throw new UnauthorizedException("Your session is invalid or has expired.");
    }
    if (!claims.sub || !claims.organizationId) throw new UnauthorizedException("Your session is invalid or has expired.");

    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: claims.sub, organizationId: claims.organizationId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!membership) throw new UnauthorizedException("Your organization membership is no longer active.");
    request.user = {
      id: membership.user.id,
      name: membership.user.name,
      email: membership.user.email,
      organizationId: membership.organization.id,
      organizationName: membership.organization.name,
      organizationSlug: membership.organization.slug,
      role: membership.role,
    };
    return true;
  }
}
