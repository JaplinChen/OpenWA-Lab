import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches } from 'class-validator';

export class AddKeyDto {
  // Proxy provider id (lowercase), e.g. 'gemini', 'groq', 'openai'.
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  @MaxLength(40)
  provider!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  apiKey!: string;

  // Which account this key belongs to (free text) — helps track that keys span different accounts.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  account?: string;
}
