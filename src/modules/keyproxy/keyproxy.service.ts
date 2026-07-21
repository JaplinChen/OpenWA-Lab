import { Injectable, BadRequestException } from '@nestjs/common';
import { DockerService } from '../docker/docker.service';
import { createLogger } from '../../common/services/logger.service';
import { KeyProxyEnvStore } from './keyproxy-env.store';

// Compose service name / label of the key-rotation proxy (see docker-compose.yml).
const PROXY_SERVICE = 'llm-key-proxy';
const proxyUrl = (): string => process.env.KEYPROXY_URL || 'http://llm-key-proxy:8000';

export interface KeyStatus {
  provider: string;
  index: number;
  account: string; // free-text account label (which login the key belongs to)
  masked: string; // last 4 chars only — the full key never leaves the backend
  status: string; // 'active' | 'cooldown' | 'unknown' (as reported by the proxy)
  requestCount: number;
  failureCount: number;
}

// quota-stats shape (only the fields we read). NOTE: each credential also carries `full_path` — the
// PLAINTEXT key — which we use solely to match a stored key to its status and NEVER return onward.
interface QuotaCred {
  full_path?: string;
  status?: string;
  totals?: { request_count?: number; failure_count?: number };
}
interface QuotaStats {
  providers?: Record<string, { credentials?: Record<string, QuotaCred> }>;
}

const mask = (key: string): string => '…' + key.slice(-4);

@Injectable()
export class KeyProxyService {
  private readonly logger = createLogger('KeyProxyService');
  private readonly store = new KeyProxyEnvStore();

  constructor(private readonly docker: DockerService) {}

  async listKeys(): Promise<KeyStatus[]> {
    const { keys, proxyApiKey } = this.store.read();
    const statusByKey = await this.fetchStatus(proxyApiKey);
    return keys.map(k => {
      const s = statusByKey.get(k.key);
      return {
        provider: k.provider,
        index: k.index,
        account: k.account,
        masked: mask(k.key),
        status: s?.status ?? 'unknown',
        requestCount: s?.requestCount ?? 0,
        failureCount: s?.failureCount ?? 0,
      };
    });
  }

  async addKey(provider: string, apiKey: string, account = ''): Promise<KeyStatus[]> {
    const p = provider.trim().toLowerCase();
    const k = apiKey.trim();
    if (!/^[a-z0-9_]+$/.test(p)) throw new BadRequestException('Invalid provider name');
    if (!k) throw new BadRequestException('API key is empty');
    this.store.addKey(p, k, account);
    await this.restart();
    return this.listKeys();
  }

  async deleteKey(provider: string, index: number): Promise<KeyStatus[]> {
    if (!this.store.deleteKey(provider.trim().toLowerCase(), index)) {
      throw new BadRequestException('Key not found');
    }
    await this.restart();
    return this.listKeys();
  }

  // Proxy only reads keys at startup, so every change needs a restart. A failure here is logged, not
  // thrown: the key IS saved to .env and will apply on the next restart — surfacing it as a 500 would
  // wrongly suggest the edit was lost.
  private async restart(): Promise<void> {
    try {
      await this.docker.stopService(PROXY_SERVICE);
      await this.docker.startService(PROXY_SERVICE);
    } catch (err) {
      this.logger.warn(`Key saved but proxy restart failed: ${String(err)}`);
    }
  }

  private async fetchStatus(proxyApiKey: string): Promise<Map<string, Omit<KeyStatus, 'provider' | 'index' | 'account' | 'masked'>>> {
    const out = new Map<string, Omit<KeyStatus, 'provider' | 'index' | 'account' | 'masked'>>();
    try {
      const res = await fetch(`${proxyUrl()}/v1/quota-stats`, {
        headers: proxyApiKey ? { authorization: `Bearer ${proxyApiKey}` } : {},
      });
      if (!res.ok) return out;
      const data = (await res.json()) as QuotaStats;
      for (const prov of Object.values(data.providers ?? {})) {
        for (const cred of Object.values(prov.credentials ?? {})) {
          if (typeof cred.full_path !== 'string') continue;
          out.set(cred.full_path, {
            status: cred.status ?? 'unknown',
            requestCount: cred.totals?.request_count ?? 0,
            failureCount: cred.totals?.failure_count ?? 0,
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Could not fetch proxy quota-stats: ${String(err)}`);
    }
    return out;
  }
}
