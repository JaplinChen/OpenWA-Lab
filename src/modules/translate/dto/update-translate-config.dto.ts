import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UpdateTranslateConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  groupIds?: string[];

  @IsOptional()
  @IsBoolean()
  includeFromMe?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSendIntervalMs?: number;
}
