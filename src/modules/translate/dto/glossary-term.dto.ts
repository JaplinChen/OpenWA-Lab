import { IsNotEmpty, IsString } from 'class-validator';

export class GlossaryTermDto {
  @IsString()
  @IsNotEmpty()
  zh!: string;

  @IsString()
  @IsNotEmpty()
  vi!: string;
}
