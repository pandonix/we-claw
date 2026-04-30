export interface LauncherConfig {
  openclawExecutable: string;
  gatewayPort: number;
  httpPort: number;
  host: string;
  manageGateway: boolean;
}

export function createLauncherConfig(env: NodeJS.ProcessEnv = process.env): LauncherConfig {
  return {
    openclawExecutable: env.WE_CLAW_OPENCLAW_BIN || "openclaw",
    gatewayPort: Number(env.WE_CLAW_GATEWAY_PORT || "18789"),
    httpPort: Number(env.WE_CLAW_HTTP_PORT || "4173"),
    host: "127.0.0.1",
    manageGateway: env.WE_CLAW_MANAGE_GATEWAY !== "0"
  };
}

export function isNodeCompatible(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}
