import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionGuard } from "../auth/session.guard";
import { SessionUser } from "../auth/session-user";
import { CreateScenarioDto, ImportScenariosDto, RunScenarioCollectionDto, UpdateScenarioDto } from "./scenario.dto";
import { ScenariosService } from "./scenarios.service";

@ApiTags("api-scenarios")
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller("scenarios")
export class ScenariosController {
  constructor(private readonly scenarios: ScenariosService) {}

  @Get()
  @ApiOperation({ summary: "List API scenarios in the current organization" })
  list(@CurrentUser() user: SessionUser) {
    return this.scenarios.list(user);
  }

  @Post("import")
  @ApiOperation({ summary: "Import OpenAPI request definitions into a scenario collection" })
  import(@CurrentUser() user: SessionUser, @Body() input: ImportScenariosDto) {
    return this.scenarios.importScenarios(user, input);
  }

  @Post("run-collection")
  @ApiOperation({ summary: "Queue scenarios in a collection for sequential execution" })
  runCollection(@CurrentUser() user: SessionUser, @Body() input: RunScenarioCollectionDto) {
    return this.scenarios.runCollection(user, input);
  }

  @Post()
  @ApiOperation({ summary: "Create a request scenario with response assertions" })
  create(@CurrentUser() user: SessionUser, @Body() input: CreateScenarioDto) {
    return this.scenarios.create(user, input);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a request scenario" })
  update(@CurrentUser() user: SessionUser, @Param("id") id: string, @Body() input: UpdateScenarioDto) {
    return this.scenarios.update(user, id, input);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a request scenario and its history" })
  remove(@CurrentUser() user: SessionUser, @Param("id") id: string) {
    return this.scenarios.remove(user, id);
  }

  @Post(":id/run")
  @ApiOperation({ summary: "Queue an immediate scenario run" })
  runNow(@CurrentUser() user: SessionUser, @Param("id") id: string) {
    return this.scenarios.runNow(user, id);
  }

  @Get(":id/runs")
  @ApiOperation({ summary: "List recent results for an API scenario" })
  history(@CurrentUser() user: SessionUser, @Param("id") id: string, @Query("limit", new ParseIntPipe({ optional: true })) limit = 20) {
    return this.scenarios.history(user, id, limit);
  }
}
