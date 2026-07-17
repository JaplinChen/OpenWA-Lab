import { IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import type { LlmProvider } from '../translate.service';

export class LlmProbeDto {
  @IsIn(['ollama', 'openai', 'groq', 'azure', 'gemini'])
  provider!: LlmProvider;

  @IsString()
  endpoint!: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  temperature?: number;
}
