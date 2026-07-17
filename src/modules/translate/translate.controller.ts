import { Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { TranslateService } from './translate.service';
import type { TranslateConfig } from './translate.service';
import { ContactService } from '../contact/contact.service';
import { GroupService } from '../group/group.service';
import type { Contact, Group } from '../../engine/interfaces/whatsapp-engine.types';
import { UpdateTranslateConfigDto } from './dto/update-translate-config.dto';
import { LlmProbeDto } from './dto/llm-probe.dto';
import { GlossaryTermDto } from './dto/glossary-term.dto';
import { SenderEntryDto } from './dto/sender-entry.dto';
import { ImportSendersDto } from './dto/import-senders.dto';

type GlossaryEntry = { source: string; target: string };
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

  @Get('senders')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List @mention JID->name overrides' })
  @ApiResponse({ status: 200, description: 'Sender overrides' })
  getSenders(): SenderEntry[] {
    return this.translateService.getSenders();
  }

  @Post('senders')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Add/overwrite an @mention JID->name override' })
  @ApiResponse({ status: 201, description: 'Updated sender overrides' })
  addSender(@Body() dto: SenderEntryDto): SenderEntry[] {
    return this.translateService.addSender(dto.jid, dto.name);
  }

  @Delete('senders')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Remove an @mention JID override' })
  @ApiResponse({ status: 200, description: 'Updated sender overrides' })
  removeSender(@Query('jid') jid: string): SenderEntry[] {
    return this.translateService.removeSender(jid ?? '');
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
    return this.translateService.importSenders(items);
  }
}
