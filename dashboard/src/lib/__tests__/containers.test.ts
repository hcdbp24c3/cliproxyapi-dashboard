import { describe, expect, it } from "vitest";
import {
  API_SERVICE_KEY,
  findDeploymentProject,
  resolveContainerConfig,
  type ContainerListLine,
} from "../containers";

describe("resolveContainerConfig", () => {
  it("resolves plain compose container names exactly", () => {
    expect(resolveContainerConfig("cliproxyapi")?.key).toBe("cliproxyapi");
    expect(resolveContainerConfig("cliproxyapi")?.config.displayName).toBe("CLIProxyAPI");
    expect(resolveContainerConfig("cliproxyapi-postgres")?.key).toBe("cliproxyapi-postgres");
    expect(resolveContainerConfig("cliproxyapi-postgres")?.config.displayName).toBe("PostgreSQL");
    expect(resolveContainerConfig("cliproxyapi-caddy")?.key).toBe("cliproxyapi-caddy");
    expect(resolveContainerConfig("cliproxyapi-dashboard")?.key).toBe("cliproxyapi-dashboard");
    expect(resolveContainerConfig("cliproxyapi-dashboard")?.config.displayName).toBe("Dashboard");
  });

  it("resolves Coolify-style <serviceKey>-<uuid> names via the compose service label", () => {
    const uuid = "iocoplkil9uwsjq5ycqxo5fe";
    expect(resolveContainerConfig(`cliproxyapi-${uuid}`, "cliproxyapi")?.key).toBe("cliproxyapi");
    expect(resolveContainerConfig(`postgres-${uuid}`, "postgres")?.key).toBe("cliproxyapi-postgres");
    expect(resolveContainerConfig(`dashboard-${uuid}`, "dashboard")?.key).toBe("cliproxyapi-dashboard");
    expect(resolveContainerConfig(`caddy-${uuid}`, "caddy")?.key).toBe("cliproxyapi-caddy");
  });

  it("resolves Coolify-style names from the name alone via the service-key prefix", () => {
    const uuid = "iocoplkil9uwsjq5ycqxo5fe";
    expect(resolveContainerConfig(`cliproxyapi-${uuid}`)?.key).toBe("cliproxyapi");
    expect(resolveContainerConfig(`postgres-${uuid}`)?.key).toBe("cliproxyapi-postgres");
    expect(resolveContainerConfig(`dashboard-${uuid}`)?.key).toBe("cliproxyapi-dashboard");
  });

  it("rejects containers whose service label names an unmanaged service", () => {
    const uuid = "iocoplkil9uwsjq5ycqxo5fe";
    expect(resolveContainerConfig(`docker-proxy-${uuid}`, "docker-proxy")).toBeNull();
    expect(resolveContainerConfig(`usage-collector-${uuid}`, "usage-collector")).toBeNull();
    expect(resolveContainerConfig(`backup-scheduler-${uuid}`, "backup-scheduler")).toBeNull();
  });

  it("rejects containers of unrelated applications", () => {
    expect(resolveContainerConfig("mongo-qqldk6btmaqh3q6v1ob03hhw")).toBeNull();
    expect(resolveContainerConfig("new-api-re99ewccll58g6pwl09qp105")).toBeNull();
    expect(resolveContainerConfig("komodo-1rwpqx1t0z7wyfw1upgsh8tx")).toBeNull();
  });

  it("keeps supporting legacy suffixed container names", () => {
    expect(resolveContainerConfig("cliproxyapi-postgres-a1b2c3d4")?.key).toBe("cliproxyapi-postgres");
    expect(resolveContainerConfig("cliproxyapi-dashboard-a1b2c3d4")?.key).toBe("cliproxyapi-dashboard");
  });
});

describe("findDeploymentProject", () => {
  const sample: ContainerListLine[] = [
    { name: "cliproxyapi-iocop", status: "Up 4 hours", state: "running", composeService: "cliproxyapi", composeProject: "iocoplkil9uwsjq5ycqxo5fe" },
    { name: "postgres-iocop", status: "Up 4 hours", state: "running", composeService: "postgres", composeProject: "iocoplkil9uwsjq5ycqxo5fe" },
    { name: "dashboard-iocop", status: "Up 4 hours", state: "running", composeService: "dashboard", composeProject: "iocoplkil9uwsjq5ycqxo5fe" },
    { name: "docker-proxy-iocop", status: "Up 4 hours", state: "running", composeService: "docker-proxy", composeProject: "iocoplkil9uwsjq5ycqxo5fe" },
    { name: "postgres-iptch", status: "Up 4 hours", state: "running", composeService: "postgres", composeProject: "iptch3f86n705woryunns8jo" },
    { name: "postgresql-re99", status: "Up 4 hours", state: "running", composeService: "postgresql", composeProject: "re99ewccll58g6pwl09qp105" },
  ];

  it("anchors on the CLIProxyAPI container's compose project", () => {
    expect(findDeploymentProject(sample, API_SERVICE_KEY)).toBe("iocoplkil9uwsjq5ycqxo5fe");
  });

  it("returns undefined when the API container is not present", () => {
    const withoutApi = sample.filter((c) => c.composeService !== "cliproxyapi");
    expect(findDeploymentProject(withoutApi, API_SERVICE_KEY)).toBeUndefined();
  });
});
