import { Controller, Get, Put, Post, Body, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Public, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { isPathWithin } from '../../common/utils/path-safety';
import { EngineFactory } from '../../engine/engine.factory';
import { StorageService } from '../../common/storage/storage.service';
import { createLogger } from '../../common/services/logger.service';
import { ImportStorageDto } from './dto/import-storage.dto';
import * as fs from 'fs';
import * as path from 'path';
import type { DataTransferCtx } from './infra-data-transfer.ctx';
import { exportData } from './infra-data-export';
import { importData } from './infra-data-import';
import { InfraConfigCtx, readSavedConfig, saveConfig } from './infra-config';
import { InfraStatusService } from './infra-status.service';
import { InfraRestartService, RestartResult } from './infra-restart.service';
import type {
  ExportDataResult,
  ImportDataResult,
  InfraStatus,
  SaveConfigResult,
  SaveConfigDto,
  MigrationTables,
  SavedConfigResponse,
} from './infra.types';

@ApiTags('infrastructure')
@Controller('infra')
export class InfraController {
  private readonly logger = createLogger('InfraController');

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource('data')
    private readonly dataDataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly storageService: StorageService,
    private readonly infraStatusService: InfraStatusService,
    private readonly infraRestartService: InfraRestartService,
  ) {}

  private get infraConfigCtx(): InfraConfigCtx {
    return { engineFactory: this.engineFactory, logger: this.logger };
  }

  private get dataTransferCtx(): DataTransferCtx {
    return { dataDataSource: this.dataDataSource, configService: this.configService, logger: this.logger };
  }

  @Get('status')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get infrastructure status' })
  @ApiResponse({ status: 200, description: 'Infrastructure status' })
  async getStatus(): Promise<InfraStatus> {
    return this.infraStatusService.getStatus();
  }

  @Get('engines')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get available WhatsApp engines' })
  @ApiResponse({ status: 200, description: 'List of available engines' })
  getEngines(): Array<{ id: string; name: string; enabled: boolean; features: string[] }> {
    return this.engineFactory.getAvailableEngines();
  }

  @Get('engines/current')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get current active engine' })
  @ApiResponse({ status: 200, description: 'Current engine info' })
  getCurrentEngine(): { engineType: string } {
    return { engineType: this.engineFactory.getCurrentEngine() };
  }

  @Get('config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Read the saved infrastructure configuration for the dashboard form' })
  @ApiResponse({ status: 200, description: 'Saved configuration (secrets omitted)' })
  getConfig(): SavedConfigResponse {
    return readSavedConfig();
  }

  @Put('config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Save infrastructure configuration to .env file' })
  @ApiResponse({ status: 200, description: 'Configuration saved' })
  @ApiBody({ description: 'Configuration to save' })
  saveConfig(@Body() config: SaveConfigDto): SaveConfigResult {
    return saveConfig(this.infraConfigCtx, config);
  }

  @Post('restart')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Request server restart with Docker orchestration' })
  @ApiResponse({ status: 200, description: 'Server will restart with new profiles' })
  async requestRestart(@Body() body?: { profiles?: string[]; profilesToRemove?: string[] }): Promise<RestartResult> {
    return this.infraRestartService.requestRestart(body?.profiles || [], body?.profilesToRemove || []);
  }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Server is healthy' })
  healthCheck(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('export-data')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Export all data from Data DB for migration' })
  @ApiResponse({ status: 200, description: 'Exported data as JSON' })
  async exportData(): Promise<ExportDataResult> {
    return exportData(this.dataTransferCtx);
  }

  @Post('import-data')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import data to Data DB (replaces existing data)' })
  @ApiBody({
    description: 'Exported data from export-data endpoint',
    schema: {
      type: 'object',
      properties: {
        tables: {
          type: 'object',
          properties: {
            sessions: { type: 'array' },
            webhooks: { type: 'array' },
            messages: { type: 'array' },
            messageBatches: { type: 'array' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Data imported successfully' })
  async importData(
    @Body()
    data: {
      tables: Partial<MigrationTables>;
    },
  ): Promise<ImportDataResult> {
    return importData(this.dataTransferCtx, data);
  }

  @Get('storage/files/count')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get file count in current storage' })
  @ApiResponse({ status: 200, description: 'File count and size' })
  async getStorageFileCount(): Promise<{
    storageType: string;
    count: number;
    sizeBytes: number;
    sizeMB: string;
  }> {
    const { count, sizeBytes } = await this.storageService.getFileCount();
    return {
      storageType: this.storageService.getCurrentStorageType(),
      count,
      sizeBytes,
      sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
    };
  }

  @Get('storage/export')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Export all storage files as tar.gz' })
  @ApiResponse({ status: 200, description: 'Tar.gz archive stream' })
  async exportStorage(): Promise<{ message: string; download: string }> {
    // File lifecycle (data/exports placement, TTL sweep, relative path) lives in StorageService.
    const download = await this.storageService.exportToDataDir();
    return { message: 'Storage export completed', download };
  }

  @Post('storage/import')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import storage files from tar.gz' })
  @ApiBody({ description: 'Path to tar.gz file to import' })
  @ApiResponse({ status: 200, description: 'Import result' })
  async importStorage(
    @Body() body: ImportStorageDto,
  ): Promise<{ imported: boolean; count: number; storageType: string }> {
    const { filePath } = body;

    // `filePath` is fully caller-controlled. Restrict it to the app's data
    // directory so it cannot point at arbitrary files on the host.
    const dataDir = path.join(process.cwd(), 'data');
    if (!filePath || !isPathWithin(dataDir, filePath)) {
      throw new BadRequestException('filePath must reference a file inside the data directory');
    }

    if (!fs.existsSync(filePath)) {
      throw new BadRequestException(`File not found: ${filePath}`);
    }

    const readStream = fs.createReadStream(filePath);
    const count = await this.storageService.importFromStream(readStream);

    return {
      imported: true,
      count,
      storageType: this.storageService.getCurrentStorageType(),
    };
  }
}
