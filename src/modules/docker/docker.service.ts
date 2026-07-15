import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Docker from 'dockerode';
import { ContainerInfo, OrchestrationResult } from './docker.types';
import { parseDockerOptions } from './docker-container-specs';
import { DockerCtx, listContainers, getContainerByService, getSystemInfo } from './docker-queries';
import { createService, startService, stopService, removeService, orchestrateProfiles } from './docker-operations';

// Re-exported so `../docker` barrel consumers (e.g. infra.controller) keep importing these unchanged.
export { MANAGED_DOCKER_PROFILES } from './docker-container-specs';
export type { ContainerInfo, OrchestrationResult } from './docker.types';

@Injectable()
export class DockerService implements OnModuleInit {
  private readonly logger = new Logger(DockerService.name);
  private docker: Docker | null = null;
  private isAvailable = false;
  private reinitInFlight = false;

  /** Live-connection context passed to the stateless operation helpers, rebuilt per call so a
   *  background re-init flipping `isAvailable` is picked up immediately. */
  private get ctx(): DockerCtx {
    return { docker: this.docker, isAvailable: this.isAvailable, logger: this.logger };
  }

  async onModuleInit() {
    await this.initializeDocker();
    // Bootstrap orchestration: start containers based on saved config
    await this.bootstrapOrchestration();
  }

  /**
   * Bootstrap orchestration: start built-in containers based on saved config
   * This runs on application startup to ensure containers match saved configuration
   */
  private async bootstrapOrchestration(): Promise<void> {
    if (!this.isAvailable) {
      this.logger.log('[Bootstrap Orchestration] Docker not available, skipping');
      return;
    }

    const profiles: string[] = [];

    // Check for built-in services from environment variables
    if (process.env.REDIS_BUILTIN === 'true') {
      profiles.push('redis');
    }
    if (process.env.POSTGRES_BUILTIN === 'true') {
      profiles.push('postgres');
    }
    if (process.env.MINIO_BUILTIN === 'true') {
      profiles.push('minio');
    }

    if (profiles.length === 0) {
      this.logger.log('[Bootstrap Orchestration] No built-in services configured');
      return;
    }

    this.logger.log(`[Bootstrap Orchestration] Starting built-in services: ${profiles.join(', ')}`);
    const result = await this.orchestrateProfiles(profiles);

    if (result.success) {
      this.logger.log(`[Bootstrap Orchestration] Started ${result.containersStarted.length} container(s)`);
    } else {
      this.logger.warn(`[Bootstrap Orchestration] Issues: ${result.errors.join('; ')}`);
    }
  }

  private async initializeDocker(): Promise<void> {
    try {
      this.docker = new Docker(this.buildDockerOptions());
      await this.docker.ping();
      this.isAvailable = true;
      this.logger.log('Docker API connected successfully');
    } catch (error) {
      this.logger.warn(
        'Docker not available. Container orchestration disabled.',
        error instanceof Error ? error.message : error,
      );
      this.isAvailable = false;
    }
  }

  // Visible for testing
  buildDockerOptions(): Docker.DockerOptions {
    return parseDockerOptions();
  }

  /**
   * Check if Docker is available.
   *
   * Startup-race recovery: when the API talks to the Docker socket-proxy over TCP
   * (DOCKER_HOST=tcp://...), the proxy container may not be accepting connections at
   * the moment onModuleInit runs (compose `service_started` doesn't wait for readiness).
   * If the first connect failed, retry it once in the background here so orchestration
   * recovers without a process restart. Only for the DOCKER_HOST (proxy/tcp) case — a
   * socket-based or docker-less deployment has no such race.
   */
  isDockerAvailable(): boolean {
    if (!this.isAvailable && !this.reinitInFlight && process.env.DOCKER_HOST) {
      this.reinitInFlight = true;
      void this.initializeDocker().finally(() => {
        this.reinitInFlight = false;
      });
    }
    return this.isAvailable;
  }

  listContainers(): Promise<ContainerInfo[]> {
    return listContainers(this.ctx);
  }

  async getRunningBuiltinServices(): Promise<{ database: boolean; cache: boolean; storage: boolean }> {
    // Calls this.listContainers() (not the free helper) so a spy/override on the method is honored.
    const containers = await this.listContainers();
    const isRunning = (svc: string): boolean =>
      containers.some(
        c =>
          c.labels['com.openwa-lab.service'] === svc &&
          c.labels['com.openwa-lab.builtin'] === 'true' &&
          c.state === 'running',
      );
    return { database: isRunning('database'), cache: isRunning('cache'), storage: isRunning('storage') };
  }

  getContainerByService(service: string): Promise<Docker.Container | null> {
    return getContainerByService(this.ctx, service);
  }

  createService(profile: string): Promise<boolean> {
    return createService(this.ctx, profile);
  }

  startService(service: string): Promise<boolean> {
    return startService(this.ctx, service);
  }

  removeService(profile: string): Promise<boolean> {
    return removeService(this.ctx, profile);
  }

  stopService(service: string): Promise<boolean> {
    return stopService(this.ctx, service);
  }

  orchestrateProfiles(profiles: string[]): Promise<OrchestrationResult> {
    return orchestrateProfiles(this.ctx, profiles);
  }

  getSystemInfo(): Promise<{ available: boolean; info?: Record<string, unknown> }> {
    return getSystemInfo(this.ctx);
  }
}
