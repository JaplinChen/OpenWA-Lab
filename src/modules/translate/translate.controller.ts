import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { TranslateService } from './translate.service';
import type { TranslateConfig } from './translate.service';
import { UpdateTranslateConfigDto } from './dto/update-translate-config.dto';

@ApiTags('translate')
@Controller('translate')
export class TranslateController {
  constructor(private readonly translateService: TranslateService) {}

  @Get('config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get runtime translation config' })
  @ApiResponse({ status: 200, description: 'Current translation config' })
  getConfig(): TranslateConfig {
    return this.translateService.getConfig();
  }

  @Put('config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update runtime translation config (applied immediately, no restart)' })
  @ApiResponse({ status: 200, description: 'Updated translation config' })
  updateConfig(@Body() dto: UpdateTranslateConfigDto): TranslateConfig {
    return this.translateService.updateConfig(dto);
  }
}
