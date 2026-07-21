import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { KeyProxyService, KeyStatus } from './keyproxy.service';
import { AddKeyDto } from './dto/add-key.dto';

@ApiTags('keyproxy')
@Controller('keyproxy')
export class KeyProxyController {
  constructor(private readonly service: KeyProxyService) {}

  @Get('keys')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List LLM-proxy keys (masked) with per-key rotation status' })
  @ApiResponse({ status: 200, description: 'Masked keys with usage/cooldown status' })
  list(): Promise<KeyStatus[]> {
    return this.service.listKeys();
  }

  @Post('keys')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Add a key for a provider and restart the proxy' })
  @ApiResponse({ status: 201, description: 'Updated masked key list' })
  add(@Body() dto: AddKeyDto): Promise<KeyStatus[]> {
    return this.service.addKey(dto.provider, dto.apiKey, dto.account ?? '');
  }

  @Delete('keys/:provider/:index')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Delete a provider key by index and restart the proxy' })
  @ApiResponse({ status: 200, description: 'Updated masked key list' })
  remove(
    @Param('provider') provider: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<KeyStatus[]> {
    return this.service.deleteKey(provider, index);
  }
}
