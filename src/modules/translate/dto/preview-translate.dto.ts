import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { LlmProvider } from '../translate-llm-client';

export class PreviewTranslateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;

  // Optional: preview a specific configured provider instead of the active one (A/B comparison).
  @IsOptional()
  @IsIn(['ollama', 'openai', 'groq', 'azure', 'gemini'])
  provider?: LlmProvider;
}
