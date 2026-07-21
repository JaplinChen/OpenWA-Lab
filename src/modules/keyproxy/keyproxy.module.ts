import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module';
import { KeyProxyController } from './keyproxy.controller';
import { KeyProxyService } from './keyproxy.service';

@Module({
  imports: [DockerModule],
  controllers: [KeyProxyController],
  providers: [KeyProxyService],
})
export class KeyProxyModule {}
