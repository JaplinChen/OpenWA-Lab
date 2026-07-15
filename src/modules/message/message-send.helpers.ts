import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertBase64WithinMediaCap } from './media-cap.util';
import { SendMediaMessageDto } from './dto';
import { MediaInput, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { userPart } from '../../engine/identity/wa-id';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

interface HelperLogger {
  warn(message: string): void;
}

/**
 * Expand a JID filter into every stored id that refers to the same chat/person: the literal input (so
 * an exact group/lid filter still matches), the user-part in both user dialects (`@c.us` /
 * `@s.whatsapp.net`), and every lid the resolution table maps to that phone.
 */
export function resolveJidCandidates(lidMappingStore: LidMappingStoreService, value: string): string[] {
  const phone = userPart(value);
  const candidates = new Set<string>([value, `${phone}@c.us`, `${phone}@s.whatsapp.net`]);
  for (const lid of lidMappingStore.lidsForPhone(phone)) {
    candidates.add(`${lid}@lid`);
  }
  return [...candidates];
}

/**
 * Humanising delay: show the engine's typing indicator and pause for a length-scaled, jittered
 * interval before the real send, so automated single sends don't look instantaneous (anti-ban).
 * ON by default — set `SIMULATE_TYPING=false` to disable. Engine-agnostic (goes through
 * `sendChatState`) and strictly best-effort — it never throws and never blocks the send if presence
 * fails or the engine has no presence concept. `SIMULATE_TYPING_MAX_MS` (default 5000) caps the pause.
 * Note: this covers single sends only; bulk sends use their own `delayBetweenMessages` throttle.
 */
export async function simulateTypingIfEnabled(
  engine: IWhatsAppEngine,
  chatId: string,
  text: string,
  configService: ConfigService | undefined,
  logger: HelperLogger,
): Promise<void> {
  const { simulateTyping, simulateTypingMaxMs } = resolveFeatureFlags(configService);
  if (!simulateTyping) return;
  try {
    await engine.sendChatState(chatId, 'typing');
    const maxMs = simulateTypingMaxMs;
    const planned = Math.min(maxMs, 500 + text.length * 45);
    const jittered = Math.round(planned * (0.85 + Math.random() * 0.3)); // ±15% so it isn't metronomic
    await new Promise(resolve => setTimeout(resolve, jittered));
  } catch (error) {
    logger.warn(`simulateTyping skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Map a blocked outbound media fetch (SSRF guard) to an HTTP 400 so a
 * caller-supplied internal/unsafe URL returns a client error instead of a 500.
 * The raw guard message names the resolved internal IP (a recon/DNS-rebind oracle), so return a
 * generic message to the client and keep the detail in the server log only. Others pass through.
 */
export function toClientFacingError(error: unknown, logger: HelperLogger): unknown {
  if (error instanceof SsrfBlockedError) {
    logger.warn(`Outbound media fetch blocked by SSRF guard: ${error.message}`);
    return new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE);
  }
  return error;
}

export function buildMediaInput(dto: SendMediaMessageDto): MediaInput {
  if (!dto.url && !dto.base64) {
    throw new BadRequestException('Either url or base64 must be provided');
  }

  if (dto.base64 && !dto.mimetype) {
    throw new BadRequestException('mimetype is required when using base64 data');
  }

  // Bound an outbound base64 payload to the same byte cap as URL/inbound media, before it is
  // persisted or handed to the engine. URL media is already capped while streaming.
  assertBase64WithinMediaCap(dto.base64);

  return {
    mimetype: dto.mimetype || 'application/octet-stream',
    // base64 wins over url when both are present: it is the explicit local payload, and a stale
    // `url` (e.g. a Swagger/example default left in the body) must not be fetched in its place.
    // Aligns the send selection with the base64-first persisted metadata and the url field's
    // `@ValidateIf((o) => !o.base64)` (which skips @IsUrl when base64 is present) — #670.
    data: dto.base64 || dto.url!,
    filename: dto.filename,
    caption: dto.caption,
    mentions: dto.mentions,
  };
}
