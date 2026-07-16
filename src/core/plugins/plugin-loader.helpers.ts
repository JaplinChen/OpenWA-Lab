import * as path from 'path';
import type { MessageService } from '../../modules/message/message.service';
import type { ConversationMediaType } from './conversation-send-facade';

const SANDBOX_ENV_ALLOWLIST = ['NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'TZ'] as const;

// Pure module-level helpers lifted out of plugin-loader.service.ts. Re-exported from the service so
// existing importers (src/modules/plugins/plugin-lifecycle.ts, the specs) resolve unchanged.

/**
 * Resolve a plugin's `main` entry to an absolute path, asserting it stays inside
 * <pluginsDir>/<pluginId>. `main` comes from a user-supplied manifest, so a
 * value like '../../etc/passwd' (or an absolute path) must be rejected BEFORE require().
 */
export function resolvePluginMainPath(pluginsDir: string, pluginId: string, main: string): string {
  const base = path.resolve(pluginsDir, pluginId);
  const mainPath = path.resolve(base, main);
  if (mainPath !== base && !mainPath.startsWith(base + path.sep)) {
    throw new Error(`Plugin ${pluginId} main path escapes the plugin directory`);
  }
  return mainPath;
}

/**
 * Build the minimal, allowlisted env for an untrusted plugin worker so it never inherits host secrets.
 * Only {@link SANDBOX_ENV_ALLOWLIST} keys are forwarded (unset keys are omitted, not emitted as
 * `undefined`), and NODE_ENV defaults to 'production' when the host has none.
 */
export function buildSandboxWorkerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.NODE_ENV = source.NODE_ENV ?? 'production';
  return env;
}

/**
 * Translate a normalized conversation media send into the concrete MessageService media method for the
 * envelope's type. Kept pure (no `this`) so the loader binds it directly and it can be unit-tested in
 * isolation. The switch is exhaustive over ConversationMediaType — adding a type without a case is a
 * compile error here rather than a silent runtime fall-through.
 */
export function dispatchConversationMedia(
  svc: Pick<MessageService, 'sendImage' | 'sendVideo' | 'sendAudio' | 'sendDocument'>,
  sessionId: string,
  opts: { chatId: string; url: string; type: ConversationMediaType; caption?: string },
): Promise<unknown> {
  const dto = { chatId: opts.chatId, url: opts.url, caption: opts.caption };
  switch (opts.type) {
    case 'image':
      return svc.sendImage(sessionId, dto);
    case 'video':
      return svc.sendVideo(sessionId, dto);
    case 'audio':
      return svc.sendAudio(sessionId, dto);
    case 'voice':
      // A voice envelope is a PTT note: sendAudio with ptt classifies it as 'voice' and defaults the
      // codec to audio/ogg;opus, so it renders as a WhatsApp voice bubble rather than an audio file.
      return svc.sendAudio(sessionId, { ...dto, ptt: true });
    case 'file':
      return svc.sendDocument(sessionId, dto);
  }
}
