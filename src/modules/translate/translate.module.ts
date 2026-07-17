import { Module } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { ContactModule } from '../contact/contact.module';
import { GroupModule } from '../group/group.module';
import { TranslateService } from './translate.service';
import { TranslateController } from './translate.controller';

@Module({
  imports: [MessageModule, ContactModule, GroupModule],
  controllers: [TranslateController],
  providers: [TranslateService],
})
export class TranslateModule {}
