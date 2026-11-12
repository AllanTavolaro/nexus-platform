import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Length, MaxLength } from "class-validator";

export const scenarioSecretTypes = ["API_CREDENTIAL", "SLACK_WEBHOOK"] as const;

export class CreateScenarioSecretDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  name!: string;

  @IsIn(scenarioSecretTypes)
  type!: (typeof scenarioSecretTypes)[number];

  @IsString()
  @Length(1, 4096)
  value!: string;
}

export class RotateScenarioSecretDto {
  @IsOptional()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsString()
  @Length(1, 4096)
  value!: string;
}
