import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionGuard } from "../auth/session.guard";
import { SessionUser } from "../auth/session-user";
import { AnalysisService } from "./analysis.service";

@ApiTags("analysis")
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller("analysis")
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Get("status")
  @ApiOperation({ summary: "Check whether evidence analysis is configured" })
  status() {
    return this.analysis.status();
  }

  @Post("incidents")
  @ApiOperation({ summary: "Analyze organization-scoped monitoring evidence" })
  analyzeIncidents(@CurrentUser() user: SessionUser) {
    return this.analysis.analyze(user);
  }
}
