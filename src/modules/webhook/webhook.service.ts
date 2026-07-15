import {
  Injectable,
  NotFoundException,
  Optional,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, In, LessThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { CreateWebhookDto, UpdateWebhookDto } from './dto';
import { createLogger } from '../../common/services/logger.service';
import { ListOptions, resolveListWindow } from '../../common/utils/paginate';
import { QUEUE_NAMES } from '../queue/queue-names';
import { generateIdempotencyKey } from './utils/idempotency.util';
import { evaluateFilters } from './filters/filter-evaluator';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { userPart } from '../../engine/identity/wa-id';
import {
  assertSafeFetchUrl,
  isSsrfProtectionEnabled,
  SsrfBlockedError,
  SSRF_BLOCKED_CLIENT_MESSAGE,
} from '../../common/security/ssrf-guard';
import { HookManager } from '../../core/hooks';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { WebhookJobData } from './webhook.types';
import { deliverToWebhook, testWebhook, type WebhookDeliveryDeps } from './webhook-dispatch';

// Re-exported so existing importers (and webhook.service.spec.ts) keep resolving these from
// './webhook.service' after the split into webhook.types.ts.
export type { WebhookPayload, WebhookJobData } from './webhook.types';

@Injectable()
export class WebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookService');
  private readonly queueEnabled: boolean;
  private readonly dispatchLimiter: ConcurrencyLimiter;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
    @Optional()
    @InjectQueue(QUEUE_NAMES.WEBHOOK)
    private readonly webhookQueue?: Queue<WebhookJobData>,
  ) {
    this.queueEnabled = configService.get<boolean>('queue.enabled', false);
    // Bound fan-out: cap how many matching webhooks are delivered CONCURRENTLY for one event. Without
    // it, an event matching N webhooks opens N outbound sockets at once. Default 16
    // (WEBHOOK_DISPATCH_CONCURRENCY).
    this.dispatchLimiter = new ConcurrencyLimiter(this.configService.get<number>('webhook.dispatchConcurrency', 16));
  }

  /**
   * Periodically prune webhook_delivery_failures older than WEBHOOK_FAILURE_RETENTION_DAYS
   * (default 90; set <= 0 to disable). Runs once at startup, then daily. The table is an append-only
   * log written on every terminally-failed delivery, so without this it grows without bound under a
   * receiver outage. (Mirrors AuditService's audit-log retention.)
   */
  onModuleInit(): void {
    const parsed = Number.parseInt(process.env.WEBHOOK_FAILURE_RETENTION_DAYS ?? '', 10);
    const retentionDays = Number.isInteger(parsed) ? Math.max(0, parsed) : 90;
    if (retentionDays <= 0) {
      this.logger.log('Webhook delivery-failure retention disabled (WEBHOOK_FAILURE_RETENTION_DAYS <= 0)');
      return;
    }
    const runPrune = (): void => {
      this.pruneDeliveryFailures(retentionDays)
        .then(n => {
          if (n > 0) this.logger.log(`Pruned ${n} webhook delivery-failure(s) older than ${retentionDays} day(s)`);
        })
        .catch(err =>
          this.logger.error('Webhook delivery-failure cleanup failed', err instanceof Error ? err.stack : String(err)),
        );
    };
    runPrune(); // prune once at startup
    this.cleanupTimer = setInterval(runPrune, 24 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  /**
   * Delete delivery-failure rows older than the retention window. Returns the number removed.
   */
  async pruneDeliveryFailures(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const result = await this.failureRepository.delete({ createdAt: LessThan(cutoff) });
    return result.affected || 0;
  }

  /**
   * Reject an internal/unsafe webhook URL at registration, so a bad URL fails
   * synchronously with a 400 instead of silently failing at delivery time. Honors the same
   * SSRF flag + SSRF_ALLOWED_HOSTS escape-hatch as delivery. Maps the guard error to 400.
   */
  private async validateWebhookUrl(url: string): Promise<void> {
    if (!isSsrfProtectionEnabled()) return;
    try {
      await assertSafeFetchUrl(url);
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        // The raw message names the resolved internal IP (a recon oracle): log it server-side, return generic.
        this.logger.warn(`Webhook URL rejected by SSRF guard: ${error.message}`);
        throw new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE);
      }
      throw error;
    }
  }

  async create(sessionId: string, dto: CreateWebhookDto): Promise<Webhook> {
    await this.validateWebhookUrl(dto.url);
    const webhook = this.webhookRepository.create({
      sessionId,
      url: dto.url,
      events: dto.events || ['message.received'],
      secret: dto.secret || null,
      headers: dto.headers || {},
      filters: dto.filters ?? null,
      retryCount: dto.retryCount ?? 3,
    });

    return this.webhookRepository.save(webhook);
  }

  async findBySession(sessionId: string): Promise<Webhook[]> {
    return this.webhookRepository.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
    });
  }

  async findAll(allowedSessions?: string[] | null, opts: ListOptions = {}): Promise<Webhook[]> {
    // A session-restricted key only sees its own sessions' webhooks; an unrestricted key
    // (null/empty allowlist, e.g. ADMIN) sees all — mirroring the ApiKeyGuard allowedSessions model.
    const { limit, offset } = resolveListWindow(opts.limit, opts.offset);
    const options: FindManyOptions<Webhook> = { order: { createdAt: 'DESC' }, take: limit, skip: offset };
    if (allowedSessions && allowedSessions.length > 0) {
      options.where = { sessionId: In(allowedSessions) };
    }
    return this.webhookRepository.find(options);
  }

  /**
   * Recently-failed webhook deliveries (most recent first), so an operator can see what was lost during
   * a receiver outage. ADMIN-only operational data; an optional sessionId narrows it. Bounded by the
   * shared pagination window.
   */
  async listDeliveryFailures(opts: ListOptions & { sessionId?: string } = {}): Promise<WebhookDeliveryFailure[]> {
    const { limit, offset } = resolveListWindow(opts.limit, opts.offset);
    return this.failureRepository.find({
      where: opts.sessionId ? { sessionId: opts.sessionId } : {},
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  async findOne(sessionId: string, id: string): Promise<Webhook> {
    // Scope by the URL's sessionId so one session cannot read/act on another's webhook by id.
    // A wrong-session id resolves to not-found (no cross-session existence oracle).
    const webhook = await this.webhookRepository.findOne({ where: { id, sessionId } });
    if (!webhook) {
      throw new NotFoundException(`Webhook with id '${id}' not found`);
    }
    return webhook;
  }

  async update(sessionId: string, id: string, dto: UpdateWebhookDto): Promise<Webhook> {
    const webhook = await this.findOne(sessionId, id);

    if (dto.url !== undefined) {
      await this.validateWebhookUrl(dto.url);
      webhook.url = dto.url;
    }
    if (dto.events !== undefined) webhook.events = dto.events;
    // Normalize empty string to null (parity with create) — an empty secret means "no HMAC",
    // not a stored blank that silently disables signing while looking configured.
    if (dto.secret !== undefined) webhook.secret = dto.secret || null;
    if (dto.headers !== undefined) webhook.headers = dto.headers;
    if (dto.filters !== undefined) webhook.filters = dto.filters;
    if (dto.active !== undefined) webhook.active = dto.active;
    if (dto.retryCount !== undefined) webhook.retryCount = dto.retryCount;

    return this.webhookRepository.save(webhook);
  }

  async delete(sessionId: string, id: string): Promise<void> {
    const webhook = await this.findOne(sessionId, id);
    await this.webhookRepository.remove(webhook);
  }

  async test(sessionId: string, webhookId: string): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const webhook = await this.findOne(sessionId, webhookId);
    return testWebhook({ configService: this.configService, logger: this.logger }, webhook, sessionId);
  }

  async dispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    // Callers fire-and-forget this (`void dispatch(...)`), so a failure looking up webhooks must be
    // logged and swallowed here — otherwise it surfaces as an unhandled promise rejection.
    let webhooks: Webhook[];
    try {
      webhooks = await this.webhookRepository.find({
        where: { sessionId, active: true },
      });
    } catch (error) {
      this.logger.error(`Webhook dispatch lookup failed for ${event}`, String(error), {
        sessionId,
        action: 'webhook_dispatch_lookup_failed',
      });
      return;
    }

    // Resolve a lid actor to its phone through the persistent table so a phone filter matches a
    // lid-addressed sender (e.g. an unresolved @lid group participant). Absent store -> no resolution.
    const resolveLid = (jid: string): string | null => this.lidMappingStore?.getCached(userPart(jid)) ?? null;
    const matchingWebhooks = webhooks.filter(
      w => (w.events.includes(event) || w.events.includes('*')) && evaluateFilters(w.filters, event, data, resolveLid),
    );

    // Base idempotency key for this event occurrence. occurredAt is captured once here and reused for
    // every retry of this dispatch, so recurring lifecycle events get a distinct-per-occurrence key
    // while retries of the same event stay stable. It is salted PER WEBHOOK below.
    const occurredAt = new Date().toISOString();
    const baseIdempotencyKey = generateIdempotencyKey(event, { ...data, sessionId }, occurredAt);

    // Bound fan-out: deliver to all matching webhooks concurrently, but cap in-flight deliveries at
    // WEBHOOK_DISPATCH_CONCURRENCY so an event matching many webhooks (or slow receivers) can't open an
    // unbounded number of outbound sockets at once. allSettled preserves the per-webhook isolation.
    // The per-webhook delivery engine (hook orchestration, queue/direct fallback) lives in
    // webhook-dispatch.ts; deps are read live here so a test toggling queueEnabled still steers it.
    const deps: WebhookDeliveryDeps = {
      queueEnabled: this.queueEnabled,
      webhookQueue: this.webhookQueue,
      webhookRepository: this.webhookRepository,
      failureRepository: this.failureRepository,
      hookManager: this.hookManager,
      configService: this.configService,
      logger: this.logger,
    };
    const tasks = matchingWebhooks.map(webhook =>
      this.dispatchLimiter.run(() => deliverToWebhook(deps, webhook, { event, sessionId, baseIdempotencyKey, data })),
    );
    await Promise.allSettled(tasks);
  }
}
