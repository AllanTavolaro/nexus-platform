import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { SessionUser } from "./session-user";

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): SessionUser => {
  return context.switchToHttp().getRequest<{ user: SessionUser }>().user;
});

