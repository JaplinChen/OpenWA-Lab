import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { pluginsApi } from '../../services/api';
import type { Plugin } from '../../services/api';
import { queryKeys } from '../../hooks/queries';
import { useToast } from '../Toast';
import { sparseSessionOverride } from './sparseSessionOverride';

/**
 * Renders a plugin's sandboxed-iframe config editor. The entry HTML is fetched WITH the API key
 * (which never enters the iframe) and injected as `srcdoc` into a `sandbox="allow-scripts"` iframe
 * (opaque origin — no access to the parent). The editor talks to the host over a postMessage bridge:
 *   iframe → host  { type: 'config:get' }          → host → iframe { type: 'config:value', config, schema }
 *   iframe → host  { type: 'config:save', config }  → host → iframe { type: 'config:saved' } | { type: 'config:error', message }
 * The host makes the authenticated PUT (secret redact/restore applies); the iframe only ever sees the
 * already-redacted config.
 */
export function PluginConfigUi({ plugin, sessionId }: { plugin: Plugin; sessionId?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    pluginsApi
      .getConfigUi(plugin.id)
      .then(h => {
        if (!cancelled) setHtml(h);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : t('common.unknownError'));
      });
    return () => {
      cancelled = true;
    };
  }, [plugin.id, t]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || e.source !== frame) return; // only our sandboxed iframe (its origin is opaque 'null')
      const msg = e.data as { type?: string; config?: Record<string, unknown> };
      const post = (m: unknown) => frame.postMessage(m, '*');
      if (msg?.type === 'config:get') {
        // Only expose schema-DECLARED fields (already secret-redacted by the API). An undeclared key
        // may hold a secret the host can't mask, so it never reaches the untrusted iframe; with no
        // schema there is nothing safe to send. The plugin must declare its fields to pre-fill them.
        // For a per-session editor (sessionId set), expose the resolved slice: the session's override
        // value where set, else the base value.
        const props = plugin.configSchema?.properties;
        const override = sessionId ? (plugin.sessionConfig?.[sessionId] ?? {}) : {};
        const safeConfig = props
          ? Object.fromEntries(
              Object.keys(props).flatMap(k => {
                if (sessionId && k in override) return [[k, override[k]]];
                return k in plugin.config ? [[k, plugin.config[k]]] : [];
              }),
            )
          : {};
        post({ type: 'config:value', config: safeConfig, schema: plugin.configSchema });
      } else if (msg?.type === 'config:save') {
        void (async () => {
          try {
            if (sessionId)
              await pluginsApi.updateSessionConfig(
                plugin.id,
                sessionId,
                sparseSessionOverride(msg.config ?? {}, plugin),
              );
            else await pluginsApi.updateConfig(plugin.id, msg.config ?? {});
            void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
            post({ type: 'config:saved' });
            toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
          } catch (err) {
            const message = err instanceof Error ? err.message : t('common.unknownError');
            post({ type: 'config:error', message });
            toast.error(t('plugins.toasts.saveFailed'), message);
          }
        })();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [plugin, sessionId, queryClient, t, toast]);

  if (error) return <div className="config-ui-status config-ui-error">{error}</div>;
  if (html === null)
    return (
      <div className="config-ui-status">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  return (
    <iframe
      ref={iframeRef}
      className="plugin-config-ui-frame"
      sandbox="allow-scripts"
      srcDoc={html}
      title={plugin.name}
      style={{ height: plugin.configUi?.height ?? 600 }}
    />
  );
}
