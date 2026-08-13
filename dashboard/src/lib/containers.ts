export interface ContainerPermissions {
  displayName: string;
  allowStart: boolean;
  allowStop: boolean;
  allowRestart: boolean;
}

const apiContainer = process.env.CLIPROXYAPI_CONTAINER_NAME || "cliproxyapi";
const isDevMode = apiContainer.includes("-dev-");

const postgresContainer = isDevMode ? "cliproxyapi-dev-postgres" : "cliproxyapi-postgres";
const caddyContainer = "cliproxyapi-caddy";
const dashboardContainer = isDevMode ? "cliproxyapi-dashboard" : "cliproxyapi-dashboard";

export const CONTAINER_CONFIG: Record<string, ContainerPermissions> = {
  [apiContainer]: { displayName: "CLIProxyAPI", allowStart: true, allowStop: true, allowRestart: true },
  [postgresContainer]: { displayName: "PostgreSQL", allowStart: false, allowStop: false, allowRestart: false },
  ...(isDevMode ? {} : {
    [caddyContainer]: { displayName: "Caddy", allowStart: false, allowStop: false, allowRestart: true },
    [dashboardContainer]: { displayName: "Dashboard", allowStart: false, allowStop: false, allowRestart: false },
  }),
};

/**
 * Compose service key → CONTAINER_CONFIG key.
 *
 * Docker Compose labels every container with `com.docker.compose.service`
 * (the service key from the compose file). Managed platforms such as Coolify
 * override `container_name` to `<serviceKey>-<uuid>` but keep these labels,
 * so the service key is the reliable way to identify this stack's containers.
 */
export const COMPOSE_SERVICE_KEYS: Record<string, string> = (() => {
  const map: Record<string, string> = {
    cliproxyapi: apiContainer,
    postgres: postgresContainer,
    caddy: caddyContainer,
    dashboard: dashboardContainer,
  };
  // Drop services that are not managed in the current mode (e.g. caddy/dashboard
  // in dev mode, where CONTAINER_CONFIG omits them).
  return Object.fromEntries(
    Object.entries(map).filter(([, configKey]) => configKey in CONTAINER_CONFIG),
  );
})();

/** Compose service key of the CLIProxyAPI container — anchor for finding this deployment's compose project. */
export const API_SERVICE_KEY: string =
  Object.keys(COMPOSE_SERVICE_KEYS).find((k) => COMPOSE_SERVICE_KEYS[k] === apiContainer) ?? "cliproxyapi";

/** A single line of `docker ps --format` output (name/status/state + compose labels). */
export interface ContainerListLine {
  name: string;
  status: string;
  state: string;
  composeService?: string;
  composeProject?: string;
}

/**
 * Find this deployment's compose project by anchoring on the CLIProxyAPI
 * container (identified by its `com.docker.compose.service` label). All
 * containers of a compose/Coolify deployment share `com.docker.compose.project`.
 */
export function findDeploymentProject(
  containers: ContainerListLine[],
  apiServiceKey: string,
): string | undefined {
  return containers.find((c) => c.composeService === apiServiceKey)?.composeProject;
}

export const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/**
 * Resolve a container (name as reported by `docker ps`, optionally with its
 * `com.docker.compose.service` label) to its known config.
 *
 * Plain Docker Compose deployments use the exact container name from the
 * compose file (e.g. `cliproxyapi-dashboard`). Managed platforms such as
 * Coolify override `container_name` to `<serviceKey>-<uuid>` (e.g.
 * `dashboard-iocoplkil9uwsjq5ycqxo5fe`), so the container name alone no longer
 * matches. Resolution order:
 *  1. `com.docker.compose.service` label (most reliable; a label naming an
 *     unmanaged service — e.g. `docker-proxy` — is rejected outright),
 *  2. exact container_name, then
 *  3. longest known prefix over container names AND compose service keys.
 * Longest-prefix wins, so `cliproxyapi-postgres-<uuid>` maps to the PostgreSQL
 * config instead of the shorter `cliproxyapi` (CLIProxyAPI API) key.
 */
export function resolveContainerConfig(
  name: string,
  composeService?: string,
): { key: string; config: ContainerPermissions } | null {
  const n = name.replace(/^\//, "");

  // 1. Compose service label is the most reliable signal (Coolify / compose).
  if (composeService) {
    const configKey = COMPOSE_SERVICE_KEYS[composeService];
    if (!configKey) {
      // Label identifies a service we don't manage (e.g. docker-proxy,
      // usage-collector, another app's service) — not part of this stack.
      return null;
    }
    const config = CONTAINER_CONFIG[configKey];
    if (config) {
      return { key: configKey, config };
    }
  }

  // 2. Exact container_name match (plain compose `container_name`, `docker run`).
  const exact = CONTAINER_CONFIG[n];
  if (exact) {
    return { key: n, config: exact };
  }

  // 3. Longest known prefix over container names AND compose service keys,
  //    covering Coolify-style `<serviceKey>-<uuid>` names.
  const prefixes = [
    ...Object.keys(CONTAINER_CONFIG),
    ...Object.keys(COMPOSE_SERVICE_KEYS),
  ];
  const key = prefixes
    .filter((k) => n.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];

  if (key) {
    const configKey = COMPOSE_SERVICE_KEYS[key] ?? (key in CONTAINER_CONFIG ? key : undefined);
    const config = configKey ? CONTAINER_CONFIG[configKey] : undefined;
    if (configKey && config) {
      return { key: configKey, config };
    }
  }

  return null;
}

const ACTION = {
  START: "start",
  STOP: "stop",
  RESTART: "restart",
} as const;

export type ContainerAction = (typeof ACTION)[keyof typeof ACTION];

export function isValidContainerName(name: string): boolean {
  return CONTAINER_NAME_PATTERN.test(name) && resolveContainerConfig(name) !== null;
}

export function getAllowedActions(containerName: string, state: string): ContainerAction[] {
  const config = resolveContainerConfig(containerName)?.config;
  if (!config) return [];

  const actions: ContainerAction[] = [];

  if (config.allowStart && state !== "running" && state !== "restarting") {
    actions.push(ACTION.START);
  }
  if (config.allowStop && (state === "running" || state === "restarting" || state === "paused")) {
    actions.push(ACTION.STOP);
  }
  if (config.allowRestart && (state === "running" || state === "restarting" || state === "paused")) {
    actions.push(ACTION.RESTART);
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Container detail helpers (used by /api/containers/[name]/details)
// ---------------------------------------------------------------------------

export interface ContainerPort {
  containerPort: number;
  protocol: "tcp" | "udp";
  hostIp?: string;
  hostPort?: number;
}

export interface ContainerMount {
  type: "bind" | "volume" | "tmpfs";
  source: string;
  destination: string;
  readOnly: boolean;
}

type HealthStatus = "healthy" | "unhealthy" | "starting" | "none";

export function normalizeHealthStatus(raw: string): HealthStatus {
  const lower = raw.toLowerCase().trim();
  if (lower === "healthy") return "healthy";
  if (lower === "unhealthy") return "unhealthy";
  if (lower === "starting") return "starting";
  return "none";
}

export function extractEnvKeys(envArray: string[]): string[] {
  return envArray.map((entry) => {
    const eqIdx = entry.indexOf("=");
    return eqIdx === -1 ? entry : entry.slice(0, eqIdx);
  });
}

export function parseRestartInfo(
  restartCount: number,
  exitCode?: number,
  error?: string,
): { restartCount: number; exitCode?: number; error?: string } {
  return {
    restartCount,
    ...(exitCode !== undefined && { exitCode }),
    ...(error && { error }),
  };
}

export function parseServiceLabels(
  labels: Record<string, string>,
): { project?: string; service?: string; version?: string } {
  return {
    ...(labels["com.docker.compose.project"] && { project: labels["com.docker.compose.project"] }),
    ...(labels["com.docker.compose.service"] && { service: labels["com.docker.compose.service"] }),
    ...(labels["org.opencontainers.image.version"] && { version: labels["org.opencontainers.image.version"] }),
  };
}
