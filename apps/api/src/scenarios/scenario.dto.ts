import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsJSON, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from "class-validator";

export const scenarioMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const assertionTypes = ["STATUS_CODE", "BODY_CONTAINS", "RESPONSE_TIME_MS"] as const;

export class ScenarioAssertionDto {
  @IsIn(assertionTypes)
  type!: (typeof assertionTypes)[number];

  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(1, 250)
  expected!: string;
}

export class ScenarioHeaderDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  value?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  secretId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  prefix?: string;
}

export class ImportedScenarioDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  name!: string;

  @IsIn(scenarioMethods)
  method!: (typeof scenarioMethods)[number];

  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(8, 2048)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  @IsJSON()
  body?: string | null;
}

export class ImportScenariosDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  collectionName!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ImportedScenarioDto)
  requests!: ImportedScenarioDto[];
}

export class RunScenarioCollectionDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  collectionName!: string;
}

export class CreateScenarioDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  name!: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  collectionName?: string;

  @IsIn(scenarioMethods)
  method!: (typeof scenarioMethods)[number];

  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(8, 2048)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  @IsJSON()
  body?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ScenarioAssertionDto)
  assertions!: ScenarioAssertionDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ScenarioHeaderDto)
  headers?: ScenarioHeaderDto[];

  @IsOptional()
  @IsInt()
  @Min(300)
  @Max(86400)
  scheduleIntervalSec?: number | null;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  slackWebhookSecretId?: string | null;
}

export class UpdateScenarioDto {
  @IsOptional()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  collectionName?: string;

  @IsOptional()
  @IsIn(scenarioMethods)
  method?: (typeof scenarioMethods)[number];

  @IsOptional()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(8, 2048)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  @IsJSON()
  body?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ScenarioAssertionDto)
  assertions?: ScenarioAssertionDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ScenarioHeaderDto)
  headers?: ScenarioHeaderDto[];

  @IsOptional()
  @IsInt()
  @Min(300)
  @Max(86400)
  scheduleIntervalSec?: number | null;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  slackWebhookSecretId?: string | null;
}
