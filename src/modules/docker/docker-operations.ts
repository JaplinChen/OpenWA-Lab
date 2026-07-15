import { OrchestrationResult } from './docker.types';
import {
  PROFILE_TO_SERVICE,
  SERVICE_TO_PROFILE,
  getContainerSpec,
  buildContainerConfig,
} from './docker-container-specs';
import { DockerCtx, getContainerByService } from './docker-queries';

export type { DockerCtx } from './docker-queries';

/** Create and start a service using the Docker API directly. */
export async function createService(ctx: DockerCtx, profile: string): Promise<boolean> {
  const { docker, isAvailable, logger } = ctx;
  if (!docker || !isAvailable) {
    logger.error('Docker not available for creating service');
    return false;
  }

  const spec = getContainerSpec(profile);
  if (!spec) {
    logger.error(`Unknown profile: ${profile}`);
    return false;
  }

  logger.log(`Creating service: ${profile} (image: ${spec.image})`);

  try {
    // Check if container already exists
    const existing = await getContainerByService(ctx, profile);
    if (existing) {
      const info = await existing.inspect();
      if (info.State.Running) {
        logger.log(`Container ${spec.name} already running`);
        return true;
      }
      // Start existing container
      await existing.start();
      logger.log(`Started existing container: ${spec.name}`);
      return true;
    }

    // Pull image first
    logger.log(`Pulling image: ${spec.image}`);
    await new Promise<void>((resolve, reject) => {
      void docker.pull(spec.image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => {
          if (err2) return reject(err2);
          resolve();
        });
      });
    });

    // Create volume if needed
    if (spec.volumes) {
      for (const vol of spec.volumes) {
        try {
          await docker.createVolume({ Name: vol.name });
          logger.log(`Created volume: ${vol.name}`);
        } catch (error) {
          logger.debug(`Volume ${vol.name} creation skipped (may already exist)`, { error: String(error) });
        }
      }
    }

    const container = await docker.createContainer(buildContainerConfig(spec, profile));
    await container.start();
    logger.log(`Created and started container: ${spec.name}`);
    return true;
  } catch (error) {
    logger.error(`Failed to create service ${profile}: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** Start a container by service name — creates it if it does not exist. */
export async function startService(ctx: DockerCtx, service: string): Promise<boolean> {
  const { logger } = ctx;
  const container = await getContainerByService(ctx, service);

  if (!container) {
    // Container doesn't exist - create it using docker-compose
    logger.log(`Container for service '${service}' not found, creating...`);
    const profile = SERVICE_TO_PROFILE[service] || service;
    return createService(ctx, profile);
  }

  try {
    const info = await container.inspect();
    if (info.State.Running) {
      logger.log(`Service '${service}' is already running`);
      return true;
    }

    await container.start();
    logger.log(`Started service: ${service}`);
    return true;
  } catch (error) {
    logger.error(`Failed to start service: ${service}`, error);
    return false;
  }
}

/** Stop and remove a container by profile to save space (named data volumes are preserved). */
export async function removeService(ctx: DockerCtx, profile: string): Promise<boolean> {
  const { logger } = ctx;
  logger.log(`Removing service with profile: ${profile}`);

  const service = PROFILE_TO_SERVICE[profile] || profile;
  const container = await getContainerByService(ctx, service);

  if (container) {
    try {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop();
        logger.log(`Stopped container: ${profile}`);
      }
      // v: true removes only the container's ANONYMOUS volumes; named datastore volumes
      // (redis/postgres/minio data) are preserved, so disable + re-enable keeps the data.
      await container.remove({ v: true });
      logger.log(`Removed container: ${profile}`);
      return true;
    } catch (error) {
      logger.error(`Failed to remove container: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  // Container doesn't exist - that's fine for removal
  logger.log(`Container for service '${profile}' not found, nothing to remove`);
  return true;
}

/** Stop a container by service name (without removing). */
export async function stopService(ctx: DockerCtx, service: string): Promise<boolean> {
  const { logger } = ctx;
  const container = await getContainerByService(ctx, service);
  if (!container) {
    logger.warn(`Container for service '${service}' not found`);
    return true; // Already doesn't exist
  }

  try {
    const info = await container.inspect();
    if (!info.State.Running) {
      logger.log(`Service '${service}' is already stopped`);
      return true;
    }

    await container.stop();
    logger.log(`Stopped service: ${service}`);
    return true;
  } catch (error) {
    logger.error(`Failed to stop service: ${service}`, error);
    return false;
  }
}

/** Orchestrate services based on required profiles — starts containers that match the profiles. */
export async function orchestrateProfiles(ctx: DockerCtx, profiles: string[]): Promise<OrchestrationResult> {
  const { docker, isAvailable, logger } = ctx;
  // Calculate estimated time based on profiles
  // Base: 15 seconds for core restart (increased for reliability)
  let estimatedTime = 15;
  if (profiles.includes('postgres')) estimatedTime += 20; // PostgreSQL takes longer
  if (profiles.includes('redis')) estimatedTime += 13;
  if (profiles.includes('minio')) estimatedTime += 15;

  const result: OrchestrationResult = {
    success: true,
    message: '',
    containersStarted: [],
    containersStopped: [],
    containersRemoved: [],
    errors: [],
    estimatedTime,
  };

  if (!docker || !isAvailable) {
    result.success = false;
    result.message = 'Docker is not available';
    return result;
  }

  logger.log(`Orchestrating profiles: ${profiles.join(', ')}`);

  for (const profile of profiles) {
    const service = PROFILE_TO_SERVICE[profile] || profile;
    try {
      const started = await startService(ctx, service);
      if (started) {
        result.containersStarted.push(profile);
      } else {
        // Container might not exist yet - this is expected for first-time setup
        result.errors.push(
          `Service '${profile}' container not found. It may need to be created first with docker-compose.`,
        );
      }
    } catch (error) {
      result.errors.push(`Failed to start ${profile}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  if (result.errors.length > 0) {
    result.success = profiles.length > 0 && result.containersStarted.length > 0;
    result.message = result.errors.join('; ');
  } else {
    result.message = `Successfully orchestrated ${result.containersStarted.length} service(s)`;
  }

  return result;
}
