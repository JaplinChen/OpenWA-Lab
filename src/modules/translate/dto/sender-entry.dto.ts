import { IsNotEmpty, IsString } from 'class-validator';

export class SenderEntryDto {
  @IsString()
  @IsNotEmpty()
  jid!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;
}
