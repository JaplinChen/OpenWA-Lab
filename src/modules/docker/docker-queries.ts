import Docker from 'dockerode';
import { Logger } from '@nestjs/common';
import { ContainerInfo } from './docker.types';

/** The live-connection context threaded from DockerService so operations read `docker`/`isAvailable`
 *  as of each call (isAvailable can flip after a background re-init). */
export interface DockerCtx {
  docker: Docker | null;
  isAvailable: boolean;
  logger: Logger;
}

/** List all OpenWA-related containers (by label or `/openwa-lab-` name prefix). */
export async function listContainers(ctx: DockerCtx): Promise<ContainerInfo[]> {
  const { docker, isAvailable, logger } = ctx;
  if (!docker || !isAvailable) {
    return [];
  }

  try {
    const containers = await docker.listContainers({ all: true });
    return containers
      .filter(c => {
        const labels = c.Labels || {};
        return labels['com.openwa-lab.service'] || c.Names?.some(n => n.startsWith('/openwa-lab-'));
      })
      .map(c => ({
        id: c.Id.substring(0, 12),
        name: c.Names?.[0]?.replace(/^\//, '') || 'unknown',
        state: c.State || 'unknown',
        status: c.Status || 'unknown',
        labels: c.Labels || {},
      }));
  } catch (error) {
    logger.error('Failed to list containers', error);
    return [];
  }
}

/** Get container by service label, falling back to an EXACT `openwa-lab-<service>` name match. */
export async function getContainerByService(ctx: DockerCtx, service: string): Promise<Docker.Container | null> {
  const { docker, isAvailable, logger } = ctx;
  if (!docker || !isAvailable) {
    return null;
  }

  try {
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`com.openwa-lab.service=${service}`],
      },
    });

    if (containers.length > 0) {
      return docker.getContainer(containers[0].Id);
    }

    // Fallback: try by EXACT name (never a substring — a substring, and especially the empty
    // string, would resolve an arbitrary container). OpenWA-managed containers are `openwa-lab-<service>`.
    const target = `openwa-lab-${service}`;
    const allContainers = await docker.listContainers({ all: true });
    const match = allContainers.find(c => c.Names?.some(n => n === target || n === `/${target}`));

    if (match) {
      return docker.getContainer(match.Id);
    }

    return null;
  } catch (error) {
    logger.error(`Failed to get container for service: ${service}`, error);
    return null;
  }
}

/** Get Docker system info (counts, versions), or `{ available: false }` when Docker is unreachable. */
export async function getSystemInfo(ctx: DockerCtx): Promise<{ available: boolean; info?: Record<string, unknown> }> {
  const { docker, isAvailable, logger } = ctx;
  if (!docker || !isAvailable) {
    return { available: false };
  }

  try {
    const info = (await docker.info()) as {
      Containers: number;
      ContainersRunning: number;
      ContainersPaused: number;
      ContainersStopped: number;
      Images: number;
      ServerVersion: string;
      OperatingSystem: string;
      Architecture: string;
    };
    return {
      available: true,
      info: {
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        containersPaused: info.ContainersPaused,
        containersStopped: info.ContainersStopped,
        images: info.Images,
        serverVersion: info.ServerVersion,
        operatingSystem: info.OperatingSystem,
        architecture: info.Architecture,
      },
    };
  } catch (error) {
    logger.error('Failed to get Docker info', error);
    return { available: false };
  }
}
