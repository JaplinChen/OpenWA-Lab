import { IsNotEmpty, IsString } from 'class-validator';

export class ImportSendersDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;
}
