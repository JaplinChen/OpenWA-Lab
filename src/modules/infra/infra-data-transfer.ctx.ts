import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';

// Shared context for the Data-DB migration paths (export + import).

interface DataTransferLogger {
  log(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, trace?: unknown, meta?: Record<string, unknown>): void;
}

/** Collaborators for the Data-DB export/import. All constructor-stable on InfraController — this path
 *  only touches the data DataSource + config, never infra/docker state. */
export interface DataTransferCtx {
  dataDataSource: DataSource;
  configService: ConfigService;
  logger: DataTransferLogger;
}
