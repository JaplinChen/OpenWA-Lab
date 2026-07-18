import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';
import type { LlmProvider } from '../translate.service';

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

  @IsOptional()
  @IsIn(['ollama', 'openai', 'groq', 'azure', 'gemini'])
  llmProvider?: LlmProvider;

  @IsOptional()
  @IsString()
  llmEndpoint?: string;

  @IsOptional()
  @IsString()
  llmModel?: string;

  @IsOptional()
  @IsString()
  llmApiKey?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  llmTemperature?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  llmFallbackModels?: string[];

  @IsOptional()
  @IsString()
  llmPromptTemplate?: string;

  @IsOptional()
  @IsObject()
  llmProviderConfigs?: Record<string, Record<string, unknown>>;
}
