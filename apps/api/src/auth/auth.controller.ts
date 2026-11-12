import { Body, Controller, Get, Post, Res, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./current-user.decorator";
import { LoginDto, RegisterDto } from "./auth.dto";
import { SessionGuard } from "./session.guard";
import { SessionUser, toSessionResponse } from "./session-user";

const SESSION_COOKIE = "nexus_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  @ApiOperation({ summary: "Register an account and create its first organization" })
  async register(@Body() input: RegisterDto, @Res({ passthrough: true }) response: Response) {
    const { token, session } = await this.auth.register(input);
    response.cookie(SESSION_COOKIE, token, this.cookieOptions());
    return session;
  }

  @Post("login")
  @ApiOperation({ summary: "Sign in to NEXUS" })
  async login(@Body() input: LoginDto, @Res({ passthrough: true }) response: Response) {
    const { token, session } = await this.auth.login(input);
    response.cookie(SESSION_COOKIE, token, this.cookieOptions());
    return session;
  }

  @Post("logout")
  @ApiOperation({ summary: "Clear the current session" })
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
    return { status: "ok" };
  }

  @Get("me")
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: "Return the signed-in user and current organization" })
  me(@CurrentUser() user: SessionUser) {
    return toSessionResponse(user);
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      maxAge: SESSION_MAX_AGE,
      path: "/",
    };
  }
}
