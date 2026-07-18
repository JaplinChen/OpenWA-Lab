import { Controller, Post, Get, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { BulkMessageService } from './bulk-message.service';
import { SendBulkMessageDto, BulkMessageResponseDto } from './dto/bulk-message.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

/**
 * Bulk / batch messaging endpoints. Shares the `sessions/:sessionId/messages` prefix with
 * MessageController; registered AFTER it in MessageModule so route match order is unchanged.
 */
@ApiTags('messages')
@Controller('sessions/:sessionId/messages')
export class BulkMessageController {
  constructor(private readonly bulkMessageService: BulkMessageService) {}

  @Post('send-bulk')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send messages to multiple recipients (async batch processing)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 202,
    description: 'Batch created and processing started',
    type: BulkMessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or invalid request',
  })
  async sendBulk(
    @Param('sessionId') sessionId: string,
    @Body() dto: SendBulkMessageDto,
  ): Promise<BulkMessageResponseDto> {
    const batch = await this.bulkMessageService.createBatch(sessionId, dto);
    const estimatedTime = new Date(Date.now() + batch.messages.length * (batch.options?.delayBetweenMessages || 3000));

    return {
      batchId: batch.batchId,
      status: batch.status,
      totalMessages: batch.messages.length,
      estimatedCompletionTime: estimatedTime.toISOString(),
      statusUrl: `/api/sessions/${sessionId}/messages/batch/${batch.batchId}`,
    };
  }

  @Get('batch/:batchId')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get batch processing status' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'batchId', description: 'Batch ID' })
  @ApiResponse({
    status: 200,
    description: 'Batch status and progress',
  })
  @ApiResponse({
    status: 404,
    description: 'Batch not found',
  })
  async getBatchStatus(@Param('sessionId') sessionId: string, @Param('batchId') batchId: string) {
    const batch = await this.bulkMessageService.getBatchStatus(sessionId, batchId);
    return {
      batchId: batch.batchId,
      status: batch.status,
      progress: batch.progress,
      results: batch.results,
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
    };
  }

  @Post('batch/:batchId/cancel')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a running batch' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'batchId', description: 'Batch ID' })
  @ApiResponse({
    status: 200,
    description: 'Batch cancelled',
  })
  @ApiResponse({
    status: 400,
    description: 'Batch already completed or cancelled',
  })
  @ApiResponse({
    status: 404,
    description: 'Batch not found',
  })
  async cancelBatch(@Param('sessionId') sessionId: string, @Param('batchId') batchId: string) {
    const batch = await this.bulkMessageService.cancelBatch(sessionId, batchId);
    return {
      batchId: batch.batchId,
      status: batch.status,
      progress: batch.progress,
    };
  }
}
