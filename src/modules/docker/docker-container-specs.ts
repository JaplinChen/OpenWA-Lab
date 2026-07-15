import Docker from 'dockerode';

/**
 * The only Docker profiles OpenWA manages (and may start/stop/remove). Used to bound teardown so a
 * caller-supplied profile name can never reach removeService for an unrelated container.
 */
export const MANAGED_DOCKER_PROFILES: readonly string[] = ['postgres', 'redis', 'minio'];

/** profile (compose name) -> `com.openwa-lab.service` label value. */
export const PROFILE_TO_SERVICE: Record<string, string> = {
  postgres: 'database',
  redis: 'cache',
  minio: 'storage',
};

/** service name (label value or alias) -> compose profile. Also maps profile names to themselves. */
export const SERVICE_TO_PROFILE: Record<string, string> = {
  database: 'postgres',
  cache: 'redis',
  storage: 'minio',
  postgres: 'postgres',
  redis: 'redis',
  minio: 'minio',
};

export interface ContainerSpec {
  image: string;
  name: string;
  alias: string; // DNS alias for network resolution
  env?: string[];
  cmd?: string[];
  volumes?: { name: string; path: string }[];
  healthcheck?: { test: string[]; interval: number; timeout: number; retries: number };
  labels: Record<string, string>;
  ports?: { container: number; host: number }[];
}

/** Resolve the dockerode connection options from DOCKER_HOST (tcp://host:port) or the default socket. */
export function parseDockerOptions(): Docker.DockerOptions {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    const match = /^tcp:\/\/([^:]+):(\d+)$/.exec(dockerHost);
    if (match) {
      return { host: match[1], port: parseInt(match[2], 10), protocol: 'http' };
    }
  }
  return { socketPath: '/var/run/docker.sock' };
}

/**
 * Container specifications for optional services. Mirrors docker-compose.yml settings but uses the
 * Docker API directly. Returns null for an unknown profile.
 */
export function getContainerSpec(profile: string): ContainerSpec | null {
  const specs: Record<string, ContainerSpec> = {
    redis: {
      image: 'redis:7-alpine',
      name: 'openwa-lab-redis',
      alias: 'redis', // DNS alias for resolution
      cmd: ['redis-server', '--appendonly', 'yes'],
      volumes: [{ name: 'openwa_redis-data', path: '/data' }],
      healthcheck: {
        test: ['CMD', 'redis-cli', 'ping'],
        interval: 5000000000, // 5s in nanoseconds
        timeout: 3000000000,
        retries: 5,
      },
      labels: {
        'com.openwa-lab.service': 'cache',
        'com.openwa-lab.builtin': 'true',
      },
    },
    postgres: {
      image: 'postgres:16-alpine',
      name: 'openwa-lab-postgres',
      alias: 'postgres',
      // Use hardcoded defaults for built-in container (don't inherit SQLite paths)
      env: ['POSTGRES_USER=openwa', 'POSTGRES_PASSWORD=openwa', 'POSTGRES_DB=openwa'],
      volumes: [{ name: 'openwa_postgres-data', path: '/var/lib/postgresql/data' }],
      healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U openwa'],
        interval: 5000000000,
        timeout: 3000000000,
        retries: 5,
      },
      labels: {
        'com.openwa-lab.service': 'database',
        'com.openwa-lab.builtin': 'true',
      },
    },
    minio: {
      image: 'minio/minio',
      name: 'openwa-lab-minio',
      alias: 'minio',
      cmd: ['server', '/data', '--console-address', ':9001'],
      env: [
        // Prefer the canonical names the app/dashboard use; fall back to the legacy ones, then the
        // built-in default, so the bundled MinIO and the app share credentials.
        `MINIO_ROOT_USER=${process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || 'minioadmin'}`,
        `MINIO_ROOT_PASSWORD=${process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || 'minioadmin'}`,
      ],
      volumes: [{ name: 'openwa_minio-data', path: '/data' }],
      ports: [
        { container: 9000, host: 9000 },
        { container: 9001, host: 9001 },
      ],
      healthcheck: {
        test: ['CMD', 'curl', '-f', 'http://localhost:9000/minio/health/live'],
        interval: 10000000000,
        timeout: 5000000000,
        retries: 3,
      },
      labels: {
        'com.openwa-lab.service': 'storage',
        'com.openwa-lab.builtin': 'true',
      },
    },
  };
  return specs[profile] || null;
}

/** Assemble the dockerode ContainerCreateOptions for a spec (network aliases, binds, ports, health). */
export function buildContainerConfig(spec: ContainerSpec, profile: string): Docker.ContainerCreateOptions {
  return {
    name: spec.name,
    Image: spec.image,
    Cmd: spec.cmd,
    Env: spec.env,
    Labels: spec.labels,
    HostConfig: {
      NetworkMode: 'openwa-lab-network',
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: spec.volumes?.map(v => `${v.name}:${v.path}`),
      PortBindings: spec.ports?.reduce<Record<string, { HostIp: string; HostPort: string }[]>>((acc, p) => {
        acc[`${p.container}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: p.host.toString() }];
        return acc;
      }, {}),
    },
    Healthcheck: spec.healthcheck
      ? {
          Test: spec.healthcheck.test,
          Interval: spec.healthcheck.interval,
          Timeout: spec.healthcheck.timeout,
          Retries: spec.healthcheck.retries,
        }
      : undefined,
    NetworkingConfig: {
      EndpointsConfig: {
        'openwa-lab-network': {
          Aliases: [spec.alias, profile], // Add DNS aliases for network resolution
        },
      },
    },
  };
}
