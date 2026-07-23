import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { TranslateService } from './translate.service';
import type { TranslateConfig } from './translate.service';
import type { PendingSuggestion } from './translate-glossary';
import type { Candidate } from './translate-memory';
import type { PhraseCandidate } from './translate-phrase-candidates';
import { ContactService } from '../contact/contact.service';
import { GroupService } from '../group/group.service';
import type { Contact, Group } from '../../engine/interfaces/whatsapp-engine.types';
import { UpdateTranslateConfigDto } from './dto/update-translate-config.dto';
import { LlmProbeDto } from './dto/llm-probe.dto';
import { PreviewTranslateDto } from './dto/preview-translate.dto';
import { GlossaryTermDto } from './dto/glossary-term.dto';
import { SenderEntryDto } from './dto/sender-entry.dto';
import { ImportSendersDto } from './dto/import-senders.dto';
import { CategoryDto } from './dto/category.dto';

type GlossaryEntry = { source: string; target: string; count?: number; category?: string };
type SenderEntry = { jid: string; name: string };

@ApiTags('translate')
@Controller('translate')
export class TranslateController {
  constructor(
    private readonly translateService: TranslateService,
    private readonly contactService: ContactService,
    private readonly groupService: GroupService,
  ) {}

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

  @Post('llm/test')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Test-connect to an LLM endpoint with the given (possibly unsaved) params' })
  @ApiResponse({ status: 201, description: '{ ok, message }' })
  testLlm(@Body() dto: LlmProbeDto): Promise<{ ok: boolean; message: string }> {
    return this.translateService.testConnection({
      provider: dto.provider,
      endpoint: dto.endpoint,
      model: dto.model ?? '',
      apiKey: dto.apiKey ?? '',
      temperature: dto.temperature ?? 0,
    });
  }

  @Post('llm/models')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List available model names for an LLM endpoint (Ollama/OpenAI-compatible)' })
  @ApiResponse({ status: 201, description: '{ models: string[] }' })
  async listLlmModels(@Body() dto: LlmProbeDto): Promise<{ models: string[] }> {
    const models = await this.translateService.listModels({
      provider: dto.provider,
      endpoint: dto.endpoint,
      apiKey: dto.apiKey ?? '',
    });
    return { models };
  }

  @Post('preview')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Translate ad-hoc text through the live pipeline (glossary/senders/casing)' })
  @ApiResponse({ status: 201, description: '{ pair, translated }' })
  async preview(@Body() dto: PreviewTranslateDto): Promise<{ pair: string; translated: string }> {
    const result = await this.translateService.preview(dto.text, dto.provider);
    if (!result.pair) throw new BadRequestException('Text is not detectable Chinese or Vietnamese');
    return result;
  }

  @Get('glossary')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List zh<->vi glossary terms' })
  @ApiResponse({ status: 200, description: 'Glossary terms (source = 中文, target = 越南文)' })
  getGlossary(): GlossaryEntry[] {
    return this.translateService.glossaryStore.entries();
  }

  @Post('glossary')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Add/overwrite a zh<->vi glossary term (both directions)' })
  @ApiResponse({ status: 201, description: 'Updated glossary terms' })
  addGlossary(@Body() dto: GlossaryTermDto): GlossaryEntry[] {
    const source = dto.zh.trim();
    const target = dto.vi.trim();
    if (!source || !target) throw new BadRequestException('zh and vi are required');
    this.translateService.glossaryStore.add(source, target, dto.category?.trim());
    return this.translateService.glossaryStore.entries();
  }

  @Delete('glossary')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Remove any glossary pairing where the term appears on either side' })
  @ApiResponse({ status: 200, description: 'Updated glossary terms' })
  removeGlossary(@Query('term') term: string): GlossaryEntry[] {
    const trimmed = (term ?? '').trim();
    if (!trimmed) throw new BadRequestException('term is required');
    this.translateService.glossaryStore.remove(trimmed);
    return this.translateService.glossaryStore.entries();
  }

  @Get('glossary/pending')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List pending glossary suggestions' })
  @ApiResponse({ status: 200, description: 'Pending suggestions' })
  getPendingGlossary(): PendingSuggestion[] {
    return this.translateService.glossaryStore.pending();
  }

  @Post('glossary/pending/:id/approve')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Approve a pending glossary suggestion into the glossary' })
  @ApiResponse({ status: 201, description: 'Remaining pending suggestions' })
  approvePendingGlossary(@Param('id', ParseIntPipe) id: number): PendingSuggestion[] {
    if (!this.translateService.glossaryStore.approve(id)) {
      throw new BadRequestException(`unknown pending id: ${id}`);
    }
    return this.translateService.glossaryStore.pending();
  }

  @Delete('glossary/pending/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Reject (drop) a pending glossary suggestion' })
  @ApiResponse({ status: 200, description: 'Remaining pending suggestions' })
  rejectPendingGlossary(@Param('id', ParseIntPipe) id: number): PendingSuggestion[] {
    if (!this.translateService.glossaryStore.reject(id)) {
      throw new BadRequestException(`unknown pending id: ${id}`);
    }
    return this.translateService.glossaryStore.pending();
  }

  @Get('memory/candidates')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Top translation-memory candidates to promote into the glossary' })
  @ApiResponse({ status: 200, description: 'Candidates ordered by frequency' })
  getMemoryCandidates(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: Candidate[]; total: number }> {
    return this.translateService.memoryCandidates(
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
    );
  }

  @Post('memory/:id/approve')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Promote a memory candidate into the glossary' })
  @ApiResponse({ status: 201, description: 'Remaining candidates' })
  approveMemoryCandidate(@Param('id', ParseIntPipe) id: number): Promise<Candidate[]> {
    return this.translateService.approveMemoryCandidate(id);
  }

  @Delete('memory/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Dismiss a memory candidate' })
  @ApiResponse({ status: 200, description: 'Remaining candidates' })
  dismissMemoryCandidate(@Param('id', ParseIntPipe) id: number): Promise<Candidate[]> {
    return this.translateService.dismissMemoryCandidate(id);
  }

  @Post('memory/phrases/scan')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Mine high-frequency phrases from translation memory + LLM-suggest terms' })
  @ApiResponse({ status: 201, description: 'Refreshed phrase candidates' })
  scanPhraseCandidates(): Promise<PhraseCandidate[]> {
    return this.translateService.scanPhrases();
  }

  @Get('memory/phrases')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'High-frequency phrase candidates awaiting review' })
  @ApiResponse({ status: 200, description: 'Phrase candidates ordered by frequency' })
  getPhraseCandidates(@Query('limit') limit?: string): Promise<PhraseCandidate[]> {
    return this.translateService.phraseCandidates(limit ? Number(limit) : undefined);
  }

  @Post('memory/phrases/:id/approve')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Promote a phrase candidate into the glossary' })
  @ApiResponse({ status: 201, description: 'Remaining phrase candidates' })
  approvePhraseCandidate(@Param('id', ParseIntPipe) id: number): Promise<PhraseCandidate[]> {
    return this.translateService.approvePhraseCandidate(id);
  }

  @Delete('memory/phrases/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Dismiss a phrase candidate' })
  @ApiResponse({ status: 200, description: 'Remaining phrase candidates' })
  dismissPhraseCandidate(@Param('id', ParseIntPipe) id: number): Promise<PhraseCandidate[]> {
    return this.translateService.dismissPhraseCandidate(id);
  }

  @Get('senders')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List @mention JID->name overrides' })
  @ApiResponse({ status: 200, description: 'Sender overrides' })
  getSenders(): SenderEntry[] {
    return this.translateService.senderStore.entries();
  }

  @Post('senders')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Add/overwrite an @mention JID->name override' })
  @ApiResponse({ status: 201, description: 'Updated sender overrides' })
  addSender(@Body() dto: SenderEntryDto): SenderEntry[] {
    const jid = dto.jid.trim();
    const name = dto.name.trim();
    if (!jid || !name) throw new BadRequestException('jid and name are required');
    this.translateService.senderStore.add(jid, name);
    return this.translateService.senderStore.entries();
  }

  @Delete('senders')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Remove an @mention JID override' })
  @ApiResponse({ status: 200, description: 'Updated sender overrides' })
  removeSender(@Query('jid') jid: string): SenderEntry[] {
    const trimmed = (jid ?? '').trim();
    if (!trimmed) throw new BadRequestException('jid is required');
    this.translateService.senderStore.remove(trimmed);
    return this.translateService.senderStore.entries();
  }

  @Get('categories')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List glossary categories' })
  @ApiResponse({ status: 200, description: 'Categories' })
  getCategories(): string[] {
    return this.translateService.categoryStore.list();
  }

  @Post('categories')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Add a glossary category' })
  @ApiResponse({ status: 201, description: 'Updated categories' })
  addCategory(@Body() dto: CategoryDto): string[] {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('name is required');
    return this.translateService.categoryStore.add(name);
  }

  @Delete('categories')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Remove a glossary category' })
  @ApiResponse({ status: 200, description: 'Updated categories' })
  removeCategory(@Body() dto: CategoryDto): string[] {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('name is required');
    return this.translateService.categoryStore.remove(name);
  }

  @Post('senders/import')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: "Seed sender overrides from a session's contacts + joined-group members (skips existing)" })
  @ApiResponse({ status: 201, description: 'Count added + updated overrides' })
  async importSenders(@Body() dto: ImportSendersDto): Promise<{ added: number; entries: SenderEntry[] }> {
    // Collect name-by-JID from the contact store first; group metadata rarely carries names, so
    // participants fall back to whatever the contact store already knows (harvested pushNames).
    const nameById = new Map<string, string>();
    const contacts = (await this.contactService.getContacts(dto.sessionId)) as Contact[];
    for (const c of contacts) {
      const name = (c.name || c.pushName)?.trim();
      if (c.id.endsWith('@c.us') && name) nameById.set(c.id, name);
    }

    // Walk every joined group's members (one metadata fetch per group — button-triggered, so OK).
    const groups = (await this.groupService.getGroups(dto.sessionId)) as Group[];
    for (const g of groups) {
      const info = await this.groupService.getGroupInfo(dto.sessionId, g.id).catch(() => null);
      if (!info) continue;
      for (const p of info.participants) {
        if (!p.id.endsWith('@c.us')) continue; // digit-JID members match the @<digits> mention token
        const name = p.name?.trim() || nameById.get(p.id);
        if (name) nameById.set(p.id, name);
      }
    }

    const items = [...nameById].map(([jid, name]) => ({ jid, name }));
    const added = this.translateService.senderStore.importEntries(items);
    return { added, entries: this.translateService.senderStore.entries() };
  }
}
