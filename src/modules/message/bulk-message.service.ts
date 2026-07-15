import { Injectable, Logger, BadRequestException, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { MessageBatch, BatchStatus, BatchProgress } from './entities/message-batch.entity';
import { SendBulkMessageDto } from './dto/bulk-message.dto';
import { SessionService } from '../session/session.service';
import { MessageService } from './message.service';
import { HookManager } from '../../core/hooks';
import { assertBase64WithinMediaCap } from './media-cap.util';
import { resolveMaxConcurrentBatches } from './bulk-message.helpers';
import { BatchProcessorDeps, executeBatch } from './bulk-batch-processor';

// Re-exported so existing importers (and bulk-message.service.spec.ts) keep resolving these from
// './bulk-message.service' after the split into bulk-message.helpers.ts.
export { resolveFinalBatchStatus, sanitizeBatchError, resolveMaxConcurrentBatches } from './bulk-message.helpers';

@Injectable()
export class BulkMessageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BulkMessageService.name);
  private readonly processingBatches = new Map<string, boolean>(); // Track active batches for cancellation
  private inFlightBatches = 0; // count of batches currently in processBatch (memory bound, see cap above)

  constructor(
    @InjectRepository(MessageBatch, 'data')
    private readonly batchRepository: Repository<MessageBatch>,
    private readonly sessionService: SessionService,
    private readonly messageService: MessageService,
    private readonly hookManager: HookManager,
  ) {}

  /**
   * Transition orphaned batches on startup. A batch still in PROCESSING belongs to a
   * previous (crashed/restarted) process — this fresh process is not driving it, so it would
   * otherwise be stuck in PROCESSING forever. Mark it FAILED. Auto-resume is intentionally NOT
   * done here: resuming risks re-sending messages already delivered before the crash.
   */
  async onApplicationBootstrap(): Promise<void> {
    const orphaned = await this.batchRepository.find({ where: { status: BatchStatus.PROCESSING } });
    for (const batch of orphaned) {
      batch.status = BatchStatus.FAILED;
      await this.batchRepository.save(batch);
    }
    if (orphaned.length > 0) {
      this.logger.warn(
        `Marked ${orphaned.length} orphaned PROCESSING batch(es) FAILED on startup (interrupted by a restart)`,
      );
    }
  }

  async createBatch(sessionId: string, dto: SendBulkMessageDto): Promise<MessageBatch> {
    // Validate session exists
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException(`Session '${sessionId}' is not active`);
    }

    // Bound every outbound base64 blob to the media byte cap before the whole messages array (with
    // its base64 payloads) is persisted into the batch row. Mirrors the single-send cap in
    // MessageService.buildMediaInput.
    for (const { content } of dto.messages) {
      assertBase64WithinMediaCap(content?.image?.base64);
      assertBase64WithinMediaCap(content?.video?.base64);
      assertBase64WithinMediaCap(content?.audio?.base64);
      assertBase64WithinMediaCap(content?.document?.base64);
    }

    const batchId = dto.batchId || `batch_${randomUUID().split('-')[0]}`;

    // Check if this batchId already exists FOR THIS SESSION. Scoping by sessionId (matching how
    // getBatchStatus/cancelBatch already query) makes (sessionId, batchId) the namespace: one session
    // can't deny another a batchId, and the 400-vs-202 difference can't probe another session's ids.
    const existing = await this.batchRepository.findOne({ where: { batchId, sessionId } });
    if (existing) {
      throw new BadRequestException(`Batch ID '${batchId}' already exists`);
    }

    // Reject before persisting a row when too many batches are already processing, so a burst can't
    // hold an unbounded number of full message sets (base64 media included) in memory at once.
    const maxConcurrentBatches = resolveMaxConcurrentBatches();
    if (maxConcurrentBatches > 0 && this.inFlightBatches >= maxConcurrentBatches) {
      throw new BadRequestException(`Too many bulk batches in progress (max ${maxConcurrentBatches}); retry shortly`);
    }

    const options = {
      delayBetweenMessages: dto.options?.delayBetweenMessages ?? 3000,
      randomizeDelay: dto.options?.randomizeDelay ?? true,
      stopOnError: dto.options?.stopOnError ?? false,
    };

    const progress: BatchProgress = {
      total: dto.messages.length,
      sent: 0,
      failed: 0,
      pending: dto.messages.length,
      cancelled: 0,
    };

    const batch = this.batchRepository.create({
      batchId,
      sessionId,
      status: BatchStatus.PENDING,
      messages: dto.messages as MessageBatch['messages'],
      options,
      progress,
      results: [],
      currentIndex: 0,
    });

    await this.batchRepository.save(batch);
    this.logger.log(`Created batch ${batchId} with ${dto.messages.length} messages`);

    // Start processing asynchronously
    this.processBatch(batch.id).catch(err => {
      this.logger.error(`Batch ${batchId} processing error: ${String(err)}`);
    });

    return batch;
  }

  async getBatchStatus(sessionId: string, batchId: string): Promise<MessageBatch> {
    const batch = await this.batchRepository.findOne({
      where: { batchId, sessionId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch '${batchId}' not found`);
    }

    return batch;
  }

  async cancelBatch(sessionId: string, batchId: string): Promise<MessageBatch> {
    const batch = await this.batchRepository.findOne({
      where: { batchId, sessionId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch '${batchId}' not found`);
    }

    if (batch.status === BatchStatus.COMPLETED || batch.status === BatchStatus.CANCELLED) {
      throw new BadRequestException(`Batch '${batchId}' is already ${batch.status}`);
    }

    // Signal cancellation
    this.processingBatches.set(batch.id, false);

    // Update status
    batch.status = BatchStatus.CANCELLED;
    batch.progress.cancelled = batch.progress.pending;
    batch.progress.pending = 0;
    batch.completedAt = new Date();

    await this.batchRepository.save(batch);
    this.logger.log(`Cancelled batch ${batchId}`);

    return batch;
  }

  private async processBatch(batchDbId: string): Promise<void> {
    const batch = await this.batchRepository.findOne({ where: { id: batchDbId } });
    if (!batch) return;

    this.processingBatches.set(batch.id, true);
    // Always release the in-flight marker on every exit path (engine-not-found early return, a thrown
    // save/send, or normal completion) — otherwise the map leaks an entry per such batch.
    try {
      this.inFlightBatches++;
      await executeBatch(this.batchProcessorDeps(), batch);
    } finally {
      this.inFlightBatches--;
      this.processingBatches.delete(batch.id);
    }
  }

  /** Bundle the collaborators the (stateless) batch-processing loop needs; the shared processingBatches
   *  map lets a same-process cancelBatch be observed mid-loop. */
  private batchProcessorDeps(): BatchProcessorDeps {
    return {
      batchRepository: this.batchRepository,
      sessionService: this.sessionService,
      messageService: this.messageService,
      hookManager: this.hookManager,
      logger: this.logger,
      processingBatches: this.processingBatches,
    };
  }
}
