import { Transform, Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, IsString, IsUrl, Length, Max, Min } from "class-validator";

export class CreateMonitorDto {
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  name!: string;

  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true, require_tld: false })
  @Length(8, 2048)
  url!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3600)
  intervalSec?: number;
}

export class UpdateMonitorDto {
  @IsOptional()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true, require_tld: false })
  @Length(8, 2048)
  url?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3600)
  intervalSec?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

