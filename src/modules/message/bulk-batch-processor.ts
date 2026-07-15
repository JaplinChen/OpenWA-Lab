import { Logger, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { MessageBatch, BatchStatus, BatchMessageStatus, BatchMessageResult } from './entities/message-batch.entity';
import { MessageStatus } from './entities/message.entity';
import { SessionService } from '../session/session.service';
import { MessageService } from './message.service';
import { HookManager } from '../../core/hooks';
import { MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import {
  BulkMessageContent,
  resolveFinalBatchStatus,
  sanitizeBatchError,
  applyVariables,
  sendBulkMessage,
  calculateDelay,
  sleep,
  stripBatchMediaPayloads,
} from './bulk-message.helpers';

/** Collaborators the batch-processing loop needs, threaded from BulkMessageService. The
 *  `processingBatches` map is shared so a same-process cancelBatch is observed mid-loop. */
export interface BatchProcessorDeps {
  batchRepository: Repository<MessageBatch>;
  sessionService: SessionService;
  messageService: MessageService;
  hookManager: HookManager;
  logger: Logger;
  processingBatches: Map<string, boolean>;
}

/**
 * Run a batch to completion: per-message moderation gate → send → persist, honouring cancellation
 * (in-process map AND a DB re-read for cross-replica/post-restart cancels), stopOnError, and periodic
 * progress saves. Behavior-identical extraction of BulkMessageService.executeBatch.
 */
export async function executeBatch(deps: BatchProcessorDeps, batch: MessageBatch): Promise<void> {
  const { batchRepository, sessionService, hookManager, logger, processingBatches } = deps;

  // Update status to processing
  batch.status = BatchStatus.PROCESSING;
  batch.startedAt = new Date();
  await batchRepository.save(batch);

  const engine = sessionService.getEngine(batch.sessionId);
  if (!engine) {
    batch.status = BatchStatus.FAILED;
    batch.completedAt = new Date();
    await batchRepository.save(batch);
    return;
  }

  const results: BatchMessageResult[] = batch.results || [];
  let stoppedOnError = false;
  let cancelledByDb = false;

  for (let i = batch.currentIndex; i < batch.messages.length; i++) {
    // Check for cancellation
    if (!processingBatches.get(batch.id)) {
      logger.log(`Batch ${batch.batchId} cancelled at index ${i}`);
      break;
    }

    const msg = batch.messages[i];
    const result: BatchMessageResult = {
      chatId: msg.chatId,
      status: BatchMessageStatus.PENDING,
    };

    // Hoisted so the failure hook below can report the exact (variable-applied / plugin-modified)
    // content that was attempted, even when applyVariables or the send throws.
    let content: BulkMessageContent = msg.content;
    // Set when the message:sending gate blocked this item, so the catch treats it as a moderation
    // decision (not a delivery failure) and skips message:failed — matching the single-send path,
    // where a block is a 400 with no failure hook.
    let blockedByPlugin = false;
    try {
      // Apply template variables
      content = applyVariables(msg.content, msg.variables);

      // Per-message moderation gate — the SAME message:sending hook single sends use, so a
      // compliance/moderation plugin sees bulk traffic too (bulk previously bypassed it entirely).
      // A block fails just THIS message (honouring stopOnError below); a plugin may also rewrite it.
      const gate = await hookManager.execute(
        'message:sending',
        { sessionId: batch.sessionId, input: content, type: msg.type },
        { sessionId: batch.sessionId, source: 'BulkMessageService' },
      );
      if (!gate.continue) {
        blockedByPlugin = true;
        throw new BadRequestException('Message sending blocked by plugin');
      }
      content = (gate.data as { input: BulkMessageContent }).input;

      // Send message based on type
      const messageResult = await sendBulkMessage(engine, msg.chatId, msg.type, content);

      result.status = BatchMessageStatus.SENT;
      result.messageId = messageResult.id;
      result.sentAt = new Date();
      batch.progress.sent++;
      batch.progress.pending--;

      // Persist like a single send so the message shows in chat history + stats. The engine echo
      // (onMessageCreate) fires the webhook/WS but does NOT write the DB, so without this the
      // bulk-sent message is invisible to the messages table.
      await persistSentMessage(deps, batch.sessionId, msg.chatId, msg.type, content, messageResult);

      logger.debug(`Batch ${batch.batchId}: Sent message ${i + 1}/${batch.messages.length} to ${msg.chatId}`);
    } catch (error) {
      result.status = BatchMessageStatus.FAILED;
      // Sanitize: an SSRF block names an internal address — never store/return/log it verbatim.
      const sanitized = sanitizeBatchError(error);
      result.error = sanitized;
      batch.progress.failed++;
      batch.progress.pending--;

      // Fire message:failed so alerting/analytics plugins observe bulk failures too (previously
      // none) — but NOT for a plugin gate-block, which is a moderation decision, not a delivery
      // failure (matches single send, where a block is a 400 with no message:failed).
      if (!blockedByPlugin) {
        await hookManager.execute(
          'message:failed',
          { sessionId: batch.sessionId, error: sanitized.message, input: content, type: msg.type },
          { sessionId: batch.sessionId, source: 'BulkMessageService' },
        );
      }

      logger.warn(`Batch ${batch.batchId}: Failed message ${i + 1} to ${msg.chatId}: ${sanitized.message}`);

      if (batch.options.stopOnError) {
        batch.status = BatchStatus.FAILED;
        stoppedOnError = true;
        results.push(result);
        break;
      }
    }

    results.push(result);
    batch.currentIndex = i + 1;
    batch.results = results;

    // Save progress periodically (every 10 messages or last message)
    if (i % 10 === 0 || i === batch.messages.length - 1) {
      // Honor a cancellation issued by ANOTHER instance / after a restart — the in-memory Map only
      // sees same-process cancels. Re-read the status BEFORE saving so we don't clobber a CANCELLED
      // back to PROCESSING.
      const fresh = await batchRepository.findOne({ where: { id: batch.id }, select: ['status'] });
      if (fresh?.status === BatchStatus.CANCELLED) {
        cancelledByDb = true;
        logger.log(`Batch ${batch.batchId} cancelled (DB) at index ${i}`);
        break;
      }
      await batchRepository.save(batch);
    }

    // Delay before next message (except for last)
    if (i < batch.messages.length - 1 && processingBatches.get(batch.id)) {
      const delay = calculateDelay(batch.options);
      await sleep(delay);
    }
  }

  // Final update. NOTE: `batch` still holds the in-memory PROCESSING status from the start, so a
  // cancellation persisted by cancelBatch would be overwritten if we saved without re-deriving it.
  // A cancel may also have landed AFTER the last cadence re-read (multi-replica / post-restart); the
  // unconditional save below would clobber it back to a terminal non-cancelled status, so re-read
  // once more here unless we already know the batch was cancelled.
  if (!cancelledByDb) {
    const fresh = await batchRepository.findOne({ where: { id: batch.id }, select: ['status'] });
    if (fresh?.status === BatchStatus.CANCELLED) {
      cancelledByDb = true;
    }
  }
  const cancelled = cancelledByDb || !processingBatches.get(batch.id);
  batch.status = resolveFinalBatchStatus(cancelled, stoppedOnError, batch.progress);
  if (cancelled) {
    // Reconcile the counters the same way cancelBatch does, so the persisted state is consistent.
    batch.progress.cancelled = batch.progress.pending;
    batch.progress.pending = 0;
  }
  batch.completedAt = new Date();
  batch.results = results;
  // The batch is terminal now (never resumed), so drop the base64 media payloads before persisting —
  // otherwise the message_batches row retains multi-MB media forever. Intermediate (cadence) saves
  // above keep the payload so a batch interrupted mid-run can still resume from currentIndex.
  stripBatchMediaPayloads(batch.messages);
  await batchRepository.save(batch);

  logger.log(`Batch ${batch.batchId} completed: ${batch.progress.sent} sent, ${batch.progress.failed} failed`);
}

/**
 * Persist a successfully-sent batch message via the shared single-send persistence path, so it
 * shows up in chat history and stats like any other outgoing message. Best-effort: a persistence
 * failure must never flip a message that actually went out to FAILED.
 */
async function persistSentMessage(
  deps: BatchProcessorDeps,
  sessionId: string,
  chatId: string,
  type: string,
  content: BulkMessageContent,
  result: MessageResult,
): Promise<void> {
  const media = content.image ?? content.video ?? content.audio ?? content.document;
  // A bulk audio item flagged ptt is a voice note; store it in the 'voice' bucket like inbound PTT.
  const persistType = type === 'audio' && content.audio?.ptt ? 'voice' : type;
  try {
    await deps.messageService.saveOutgoingMessage(sessionId, {
      waMessageId: result.id,
      chatId,
      body: content.text ?? content.caption ?? '',
      type: persistType,
      timestamp: result.timestamp,
      status: MessageStatus.SENT,
      metadata: media
        ? {
            media: {
              mimetype: media.mimetype,
              data: media.url ?? media.base64,
              filename: media.filename,
            },
          }
        : undefined,
    });
  } catch (error) {
    deps.logger.warn(`Batch message persisted-after-send failed: ${String(error)}`);
  }
}
