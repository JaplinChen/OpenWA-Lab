import { Controller, Get, Post, Param, Query, Body, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { SessionService } from './session.service';
import { MarkChatReadDto, DeleteChatDto, SendChatStateDto } from './dto';
import { ChatSummary } from '../../engine/interfaces/whatsapp-engine.interface';
import { RequireRole, SessionScoped } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

/**
 * Chat-list operations for a session (`/sessions/:id/chats/*`). Shares the `sessions` prefix and the
 * @SessionScoped guard with SessionController; registered alongside it in SessionModule. Split out to
 * keep each controller a cohesive, sub-300-line HTTP surface.
 */
@ApiTags('sessions')
@Controller('sessions')
// The `:id` route param is a WhatsApp session id, so the ApiKeyGuard enforces a key's allowedSessions scope.
@SessionScoped()
export class SessionChatController {
  constructor(private readonly sessionService: SessionService) {}

  @Get(':id/chats')
  @ApiOperation({ summary: 'Get active chats for a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'List of active chats (most recent first)' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max chats to return (1–1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of chats to skip (for paging)' })
  async getChats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ChatSummary[]> {
    return this.sessionService.getChats(id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Post(':id/chats/read')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Mark a chat as read/seen' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chat marked as read successfully' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async markChatRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkChatReadDto,
  ): Promise<{ success: boolean }> {
    const success = await this.sessionService.sendSeen(id, dto.chatId);
    return { success };
  }

  @Post(':id/chats/unread')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Mark a chat as unread' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chat marked as unread successfully' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async markChatUnread(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkChatReadDto,
  ): Promise<{ success: boolean }> {
    const success = await this.sessionService.markUnread(id, dto.chatId);
    return { success };
  }

  @Post(':id/chats/delete')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete a chat from the chat list (e.g. a group you have left)' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chat deleted successfully' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async deleteChat(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeleteChatDto): Promise<{ success: boolean }> {
    const success = await this.sessionService.deleteChat(id, dto.chatId);
    return { success };
  }

  @Post(':id/chats/typing')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: "Send a typing/recording presence indicator to a chat (or clear it with 'paused')" })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Presence sent' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async sendChatState(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendChatStateDto,
  ): Promise<{ success: boolean }> {
    await this.sessionService.sendChatState(id, dto.chatId, dto.state);
    return { success: true };
  }
}
