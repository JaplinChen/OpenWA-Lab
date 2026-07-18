import { Controller, Post, Get, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { MessageService } from './message.service';
import { ReactMessageDto } from './dto/message-actions.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { parsePositiveInt } from '../../common/utils/parse-int';

@ApiTags('messages')
@Controller('sessions/:sessionId/messages')
export class ChatHistoryController {
  constructor(private readonly messageService: MessageService) {}

  // ========== Phase 3: Reactions ==========

  @Post('react')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Add or remove a reaction to a message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Reaction added or removed. Send empty emoji to remove reaction.',
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or message not found',
  })
  async react(@Param('sessionId') sessionId: string, @Body() dto: ReactMessageDto): Promise<{ success: boolean }> {
    await this.messageService.reactToMessage(sessionId, dto);
    return { success: true };
  }

  @Get(':chatId/history')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({
    summary: 'Fetch chat history live from WhatsApp',
    description:
      'Reads messages directly from the WhatsApp client for the given chat, bypassing the local DB. ' +
      'Useful for retrieving messages that arrived before the gateway was started.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID (e.g. 1234567890@c.us or groupId@g.us)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max messages to return (default 50)' })
  @ApiQuery({
    name: 'includeMedia',
    required: false,
    type: Boolean,
    description: 'When true, downloads media (base64) for messages that have it. Slower; default false.',
  })
  @ApiQuery({
    name: 'deep',
    required: false,
    type: Boolean,
    description:
      'When true, raises the limit ceiling from 100 to 2000 for reaching further back in history ' +
      '(whatsapp-web.js only; loads earlier messages on demand). Forces metadata-only (includeMedia ' +
      'is ignored). Large/slow requests may increase WhatsApp rate-limiting risk; default false.',
  })
  @ApiResponse({ status: 200, description: 'Chat history (most recent messages)' })
  async getChatHistory(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Query('limit') limit?: string,
    @Query('includeMedia') includeMedia?: string,
    @Query('deep') deep?: string,
  ) {
    return this.messageService.getChatHistory(
      sessionId,
      chatId,
      parsePositiveInt(limit),
      includeMedia === 'true' || includeMedia === '1',
      deep === 'true' || deep === '1',
    );
  }

  @Get(':chatId/:messageId/reactions')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get reactions for a specific message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID containing the message' })
  @ApiParam({ name: 'messageId', description: 'Message ID to get reactions for' })
  @ApiResponse({
    status: 200,
    description: 'List of reactions with senders',
  })
  async getReactions(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.messageService.getMessageReactions(sessionId, chatId, messageId);
  }
}
