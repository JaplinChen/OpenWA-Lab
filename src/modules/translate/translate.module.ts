import { Module } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { TranslateService } from './translate.service';

@Module({
  imports: [MessageModule],
  providers: [TranslateService],
})
export class TranslateModule {}
