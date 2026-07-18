import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DockerService, MANAGED_DOCKER_PROFILES } from '../docker';
import { ShutdownService } from '../../common/services/shutdown.service';
import { createLogger } from '../../common/services/logger.service';

export interface RestartResult {
  message: string;
  restarting: boolean;
  profiles: string[];
  profilesToRemove: string[];
  estimatedTime: number;
  orchestration?: object;
  removal?: object;
}

@Injectable()
export class InfraRestartService {
  private readonly logger = createLogger('InfraRestartService');

  constructor(
    private readonly dockerService: DockerService,
    private readonly shutdownService: ShutdownService,
  ) {}

  async requestRestart(profiles: string[], profilesToRemove: string[]): Promise<RestartResult> {
    let orchestrationResult: object | undefined;
    let removalResult: { removed: string[]; errors: string[] } | undefined;

    this.logger.log('Restart requested', { profiles });
    this.logger.log('Profiles to remove', { profilesToRemove });

    // If profiles are specified, orchestrate Docker containers
    if (this.dockerService.isDockerAvailable()) {
      // Remove only the profiles the Save flow explicitly asked to remove, and never one we're about to
      // (re)start. We deliberately do NOT infer teardown from the saved *_BUILTIN flag: the default
      // data/.env.generated carries POSTGRES_BUILTIN=false, so a bare compose-profile restart would
      // otherwise tear down the very backend the app is running on. (Known minor limitation: switching
      // away from a built-in backend and then reloading the page before restarting can leave the old
      // container running until the next explicit change.)
      // Only ever tear down OpenWA-managed services. An arbitrary profile name (or the empty string)
      // would otherwise reach removeService and, via container-name matching, could stop an unrelated
      // container — so constrain teardown to the managed allowlist and drop anything else.
      const requested = profilesToRemove.filter(p => !profiles.includes(p));
      const toRemove = requested.filter(p => MANAGED_DOCKER_PROFILES.includes(p));
      const ignored = requested.filter(p => !MANAGED_DOCKER_PROFILES.includes(p));
      if (ignored.length > 0) {
        this.logger.warn('Ignoring non-managed profiles in profilesToRemove', { ignored });
      }

      // First, remove containers for disabled services
      if (toRemove.length > 0) {
        this.logger.log('Removing disabled profiles...', { toRemove });
        removalResult = { removed: [], errors: [] };

        for (const profile of toRemove) {
          try {
            const success = await this.dockerService.removeService(profile);
            if (success) {
              removalResult.removed.push(profile);
            } else {
              removalResult.errors.push(`Failed to remove ${profile}`);
            }
          } catch (err) {
            removalResult.errors.push(`Error removing ${profile}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.logger.log('Removal result', { removalResult });
      }

      // Then, start containers for enabled services
      if (profiles.length > 0) {
        this.logger.log('Orchestrating enabled profiles...');
        orchestrationResult = await this.dockerService.orchestrateProfiles(profiles);
        this.logger.log('Orchestration result', { orchestrationResult });
      }
    } else {
      this.logger.warn('Docker not available, writing signal file instead');
      // Fallback: write signal file for host script
      try {
        const signalFile = path.resolve(process.cwd(), 'data', '.orchestration-request.json');
        const orchestrationRequest = {
          timestamp: new Date().toISOString(),
          profiles,
          profilesToRemove,
          action: 'restart-with-profiles',
        };
        fs.writeFileSync(signalFile, JSON.stringify(orchestrationRequest, null, 2), 'utf8');
        this.logger.log('Orchestration request written', { signalFile });
      } catch (err) {
        this.logger.error('Failed to write orchestration request', err instanceof Error ? err.message : String(err));
      }
    }

    // Schedule graceful shutdown after the configurable bounded grace (SHUTDOWN_DELAY_MS,
    // default 3s) — readiness reports 503 during the window so traffic drains first.
    void this.shutdownService.shutdown();

    // Calculate estimated time - base 15s + additional for each service (increased for reliability)
    let estimatedTime = 15;
    if (profiles.includes('postgres')) estimatedTime += 20;
    if (profiles.includes('redis')) estimatedTime += 13;
    if (profiles.includes('minio')) estimatedTime += 15;
    if (profilesToRemove.length > 0) estimatedTime += profilesToRemove.length * 5; // +5s per removal

    return {
      message:
        profiles.length > 0 || profilesToRemove.length > 0
          ? `Server is restarting. Enabling: ${profiles.join(', ') || 'none'}. Disabling: ${profilesToRemove.join(', ') || 'none'}.`
          : 'Server is restarting. Please wait...',
      restarting: true,
      profiles,
      profilesToRemove,
      estimatedTime,
      orchestration: orchestrationResult,
      removal: removalResult,
    };
  }
}
