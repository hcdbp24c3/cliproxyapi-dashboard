import { NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { API_SERVICE_KEY, findDeploymentProject, getAllowedActions, resolveContainerConfig, type ContainerAction, type ContainerListLine, type ContainerPermissions } from "@/lib/containers";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "@/lib/logger";


const execFileAsync = promisify(execFile);
const DOCKER_COMMAND_TIMEOUT_MS = 8000;
const DOCKER_MAX_BUFFER_BYTES = 1024 * 1024;

async function runDockerCommand(args: string[]) {
  return execFileAsync("docker", args, {
    timeout: DOCKER_COMMAND_TIMEOUT_MS,
    maxBuffer: DOCKER_MAX_BUFFER_BYTES,
  });
}

interface ContainerInfo {
  name: string;
  displayName: string;
  status: string;
  state: "running" | "exited" | "paused" | "restarting" | "dead" | "created" | "removing";
  uptime: number | null;
  cpu: string | null;
  memory: string | null;
  memoryPercent: string | null;
  actions: ContainerAction[];
}

export async function GET() {
  const session = await verifySession();

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { isAdmin: true },
  });

  if (!user?.isAdmin) {
    return NextResponse.json(
      { error: "Forbidden: Admin access required" },
      { status: 403 }
    );
  }

  try {
    const { stdout } = await runDockerCommand([
      "ps", "-a",
      "--format", "{{.Names}}\t{{.Status}}\t{{.State}}\t{{.Label \"com.docker.compose.service\"}}\t{{.Label \"com.docker.compose.project\"}}",
    ]);

    const lines: ContainerListLine[] = [];
    for (const raw of stdout.trim().split("\n")) {
      if (!raw) continue;
      const [name, status, state, composeService, composeProject] = raw.split("\t");
      if (!name || !status || !state) {
        logger.warn({ line: raw }, "Skipping malformed docker ps line");
        continue;
      }
      lines.push({
        name,
        status,
        state,
        composeService: composeService || undefined,
        composeProject: composeProject || undefined,
      });
    }

    // Anchor on the CLIProxyAPI container to find this deployment's compose
    // project. Containers of the same compose/Coolify deployment share
    // `com.docker.compose.project`; scoping by it excludes containers of other
    // apps on the same daemon that happen to share service names (e.g. another
    // app's `postgres-<uuid>`).
    const deploymentProject = findDeploymentProject(lines, API_SERVICE_KEY);

    // Fallback for deployments without compose labels (e.g. raw `docker run`):
    // keep containers that resolve by container_name alone.
    const relevant = deploymentProject
      ? lines.filter((c) => c.composeProject === deploymentProject)
      : lines.filter((c) => resolveContainerConfig(c.name) !== null);

    const parsedContainers: Array<{
      name: string;
      status: string;
      state: string;
      config: ContainerPermissions;
    }> = [];

    for (const line of relevant) {
      const resolved = resolveContainerConfig(line.name, line.composeService);
      if (!resolved) {
        logger.warn({ containerName: line.name }, "Skipping container without configuration");
        continue;
      }
      parsedContainers.push({ name: line.name, status: line.status, state: line.state, config: resolved.config });
    }

    const containers = await Promise.all(
      parsedContainers.map(async ({ name, status, state, config }): Promise<ContainerInfo> => {
        let uptime: number | null = null;
        let cpu: string | null = null;
        let memory: string | null = null;
        let memoryPercent: string | null = null;

        if (state === "running") {
          try {
            const { stdout: startedAt } = await runDockerCommand([
              "inspect", name,
              "--format", "{{.State.StartedAt}}",
            ]);
            const startTime = new Date(startedAt.trim());
            uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
          } catch (err) {
            logger.error({ err, containerName: name }, "Failed to get uptime for container");
          }

          try {
            const { stdout: statsOutput } = await runDockerCommand([
              "stats", name,
              "--no-stream",
              "--format", "{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}",
            ]);
            const [cpuVal, memVal, memPercVal] = statsOutput.trim().split("\t");
            cpu = cpuVal ?? null;
            memory = memVal ?? null;
            memoryPercent = memPercVal ?? null;
          } catch (err) {
            logger.error({ err, containerName: name }, "Failed to get stats for container");
          }
        }

        const validStates = ["running", "exited", "paused", "restarting", "dead", "created", "removing"] as const;
        type ContainerState = (typeof validStates)[number];
        const normalizedState: ContainerState = validStates.includes(state as ContainerState)
          ? (state as ContainerState)
          : "exited";

        return {
          name,
          displayName: config.displayName,
          status,
          state: normalizedState,
          uptime,
          cpu,
          memory,
          memoryPercent,
          actions: getAllowedActions(name, normalizedState),
        };
      })
    );

    return NextResponse.json(containers);
  } catch (error) {
    logger.error({ err: error }, "Container list error");
    return NextResponse.json(
      { error: "Failed to list containers" },
      { status: 500 }
    );
  }
}
