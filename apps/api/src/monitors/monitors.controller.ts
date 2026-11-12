import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionGuard } from "../auth/session.guard";
import { SessionUser } from "../auth/session-user";
import { CreateMonitorDto, UpdateMonitorDto } from "./monitor.dto";
import { MonitorsService } from "./monitors.service";

@ApiTags("monitors")
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller("monitors")
export class MonitorsController {
  constructor(private readonly monitors: MonitorsService) {}

  @Get()
  @ApiOperation({ summary: "List monitors in the current organization" })
  list(@CurrentUser() user: SessionUser) {
    return this.monitors.list(user);
  }

  @Post()
  @ApiOperation({ summary: "Create a monitor and schedule its first check" })
  create(@CurrentUser() user: SessionUser, @Body() input: CreateMonitorDto) {
    return this.monitors.create(user, input);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a monitor or pause/resume its schedule" })
  update(@CurrentUser() user: SessionUser, @Param("id") id: string, @Body() input: UpdateMonitorDto) {
    return this.monitors.update(user, id, input);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a monitor and its schedule" })
  remove(@CurrentUser() user: SessionUser, @Param("id") id: string) {
    return this.monitors.remove(user, id);
  }

  @Post(":id/check")
  @ApiOperation({ summary: "Queue an immediate check" })
  checkNow(@CurrentUser() user: SessionUser, @Param("id") id: string) {
    return this.monitors.checkNow(user, id);
  }

  @Get(":id/history")
  @ApiOperation({ summary: "List recent monitor check results" })
  history(@CurrentUser() user: SessionUser, @Param("id") id: string, @Query("limit", new ParseIntPipe({ optional: true })) limit = 50) {
    return this.monitors.history(user, id, limit);
  }
}
