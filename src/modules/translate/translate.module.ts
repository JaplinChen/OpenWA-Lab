import { Module } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { TranslateService } from './translate.service';
import { TranslateController } from './translate.controller';

@Module({
  imports: [MessageModule],
  controllers: [TranslateController],
  providers: [TranslateService],
})
export class TranslateModule {}
