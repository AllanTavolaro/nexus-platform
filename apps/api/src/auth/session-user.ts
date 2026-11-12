import { MembershipRole } from "@prisma/client";

export type SessionClaims = {
  sub: string;
  organizationId: string;
};

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: MembershipRole;
};

export function toSessionResponse(user: SessionUser) {
  return {
    user: { id: user.id, name: user.name, email: user.email },
    organization: {
      id: user.organizationId,
      name: user.organizationName,
      slug: user.organizationSlug,
      role: user.role,
    },
  };
}

