import { randomBytes } from 'crypto';

/** Minimal logger surface used by the startup banner (satisfied by the app logger). */
export interface BannerLogger {
  log(message: string): void;
}

/**
 * Resolves the API key to seed on first boot (when no keys exist yet).
 * Precedence: an explicit `API_MASTER_KEY` always wins; otherwise a
 * cryptographically random `owa_k1_` key is generated — the secure default,
 * including in non-production. The legacy fixed `dev-admin-key` is used only when
 * a developer explicitly opts in with `ALLOW_DEV_API_KEY=true`, never by default.
 */
export function resolveSeedApiKey(): string {
  if (process.env.API_MASTER_KEY) {
    return process.env.API_MASTER_KEY;
  }
  if (process.env.ALLOW_DEV_API_KEY === 'true') {
    return 'dev-admin-key';
  }
  return `owa_k1_${randomBytes(32).toString('hex')}`;
}

/**
 * The line to print for the API key in the startup banner. The full raw key is shown ONLY when it was
 * just created (first run, when the operator needs to capture it once). On every subsequent boot the
 * key is masked to a short non-secret fingerprint, so the live admin key is not re-written to the log
 * pipeline (Docker/Loki/CloudWatch) on each restart — it stays in `data/.api-key` (0600) and the
 * dashboard. A placeholder (e.g. "(check dashboard for keys)") is passed through unchanged.
 */
export function bannerKeyLine(displayKey: string, isNewKey: boolean): string {
  if (isNewKey) return displayKey;
  if (displayKey.startsWith('(')) return displayKey;
  return `${displayKey.slice(0, 8)}… (full key in data/.api-key or the dashboard)`;
}

/** Print the startup welcome banner (dashboard/API URLs + the API-key line). */
export function printWelcomeBanner(logger: BannerLogger, opts: { displayKey: string; isNewKey: boolean }): void {
  const { displayKey, isNewKey } = opts;
  const apiBaseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 2785}`;
  // The dashboard is served by NestJS at the same origin as the API now, so default to it.
  const dashboardUrl = process.env.DASHBOARD_URL || apiBaseUrl;
  const rule = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

  logger.log('');
  logger.log(rule);
  logger.log('');
  logger.log('  🟢 Welcome to OpenWA - WhatsApp API Gateway');
  logger.log('');
  logger.log(`  📊 Dashboard: ${dashboardUrl}`);
  logger.log(`  📚 API Docs:  ${apiBaseUrl}/api/docs`);
  logger.log('');
  logger.log(isNewKey ? '  🔑 API Key (newly created):' : '  🔑 API Key:');
  logger.log(`     ${bannerKeyLine(displayKey, isNewKey)}`);
  logger.log('');
  logger.log(rule);
  logger.log('');
}
