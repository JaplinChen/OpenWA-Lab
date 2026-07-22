import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GlossaryTermDto {
  @IsString()
  @IsNotEmpty()
  zh!: string;

  @IsString()
  @IsNotEmpty()
  vi!: string;

  @IsOptional()
  @IsString()
  category?: string;
}
