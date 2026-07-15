import { Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { TranslateService } from './translate.service';
import type { TranslateConfig } from './translate.service';
import { UpdateTranslateConfigDto } from './dto/update-translate-config.dto';
import { GlossaryTermDto } from './dto/glossary-term.dto';

type GlossaryEntry = { source: string; target: string };

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

  @Get('glossary')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List zh<->vi glossary terms' })
  @ApiResponse({ status: 200, description: 'Glossary terms (source = 中文, target = 越南文)' })
  getGlossary(): GlossaryEntry[] {
    return this.translateService.getGlossary();
  }

  @Post('glossary')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Add/overwrite a zh<->vi glossary term (both directions)' })
  @ApiResponse({ status: 201, description: 'Updated glossary terms' })
  addGlossary(@Body() dto: GlossaryTermDto): GlossaryEntry[] {
    return this.translateService.addGlossaryTerm(dto.zh, dto.vi);
  }

  @Delete('glossary')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Remove any glossary pairing where the term appears on either side' })
  @ApiResponse({ status: 200, description: 'Updated glossary terms' })
  removeGlossary(@Query('term') term: string): GlossaryEntry[] {
    return this.translateService.removeGlossaryTerm(term ?? '');
  }
}
