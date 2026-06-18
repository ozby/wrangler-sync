import { isAbsolute } from "node:path";

export type CloudflareDeployRequest = {
  readonly lane: string;
  readonly dryRun: boolean;
  readonly mode?: "deploy" | "destroy";
  readonly releaseVersion?: string;
};

export type CloudflareDeployStep = {
  readonly kind: "command";
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly runtimeProfile?: string;
  readonly env?: Record<string, string>;
};

export type CloudflareDeployPlan = {
  readonly schemaVersion: 1;
  readonly lane: string;
  readonly provider: "cloudflare";
  readonly requiredCredentials: readonly string[];
  readonly releaseVersion?: string;
  readonly steps: readonly CloudflareDeployStep[];
};

export type CloudflareDeployAdapter = {
  createPlan(request: CloudflareDeployRequest): CloudflareDeployPlan;
};

export type CloudflareAppDeployConfig = {
  readonly domain: string;
  readonly workerName: string;
};

export type CloudflarePreviewLane = {
  readonly lane: string;
  readonly hostname: string;
  readonly workerName: string;
  readonly url: string;
};

export type CloudflareDeployAdapterConfig = {
  readonly repoRoot: string;
  readonly productionScriptPath: string;
  readonly previewScriptPath: string;
  readonly app: CloudflareAppDeployConfig;
  readonly command?: string;
};

export type WranglerPreviewBaseConfig = {
  readonly $schema?: string;
  readonly main: string;
  readonly compatibility_date: string;
  readonly compatibility_flags?: readonly string[];
  readonly assets?: unknown;
  readonly observability?: unknown;
  readonly vars?: Record<string, unknown>;
};

const PREVIEW_LANE_PATTERN = /^preview[_-]([a-z0-9][a-z0-9_-]*)$/u;

export function resolveCloudflarePreviewLane(
  app: CloudflareAppDeployConfig,
  laneInput: string,
): CloudflarePreviewLane | null {
  const match = PREVIEW_LANE_PATTERN.exec(laneInput);
  if (match == null) return null;
  const suffix = match[1]?.replace(/_/gu, "-");
  if (suffix == null) return null;
  const lane = `preview-${suffix}`;
  const hostname = `${lane}.${app.domain}`;
  return {
    lane,
    hostname,
    workerName: `${app.workerName}-${lane}`,
    url: `https://${hostname}`,
  };
}

function assertAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
}

export function createCloudflareDeployAdapter(config: CloudflareDeployAdapterConfig): CloudflareDeployAdapter {
  assertAbsolutePath(config.repoRoot, "repoRoot");
  assertAbsolutePath(config.productionScriptPath, "productionScriptPath");
  assertAbsolutePath(config.previewScriptPath, "previewScriptPath");

  const command = config.command ?? "bun";
  return {
    createPlan(request): CloudflareDeployPlan {
      const preview = resolveCloudflarePreviewLane(config.app, request.lane);
      if (preview != null) {
        return {
          schemaVersion: 1,
          lane: request.lane,
          provider: "cloudflare",
          requiredCredentials: request.dryRun ? [] : ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"],
          steps: [{
            kind: "command",
            id: "preview-deploy",
            label: request.mode === "destroy"
              ? `Destroy ${request.lane} preview custom domain`
              : request.dryRun
                ? `Validate ${request.lane} preview deploy without publishing`
                : `Deploy ${request.lane} preview custom domain`,
            command,
            args: [
              config.previewScriptPath,
              "--lane",
              preview.lane,
              ...(request.mode === "destroy" ? ["--destroy"] : []),
              ...(request.dryRun ? ["--dry-run"] : []),
            ],
            cwd: config.repoRoot,
            runtimeProfile: request.dryRun ? "none" : "secrets-only",
          }],
        };
      }
      if (request.lane !== "prd") throw new Error(`Unsupported deploy lane: ${request.lane}`);
      return {
        schemaVersion: 1,
        lane: request.lane,
        provider: "cloudflare",
        requiredCredentials: request.dryRun ? [] : ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID"],
        releaseVersion: request.releaseVersion,
        steps: [{
          kind: "command",
          id: "production-deploy",
          label: request.dryRun ? "Validate production deploy without publishing" : "Deploy production Worker",
          command,
          args: [config.productionScriptPath, ...(request.dryRun ? ["--dry-run"] : [])],
          cwd: config.repoRoot,
          runtimeProfile: request.dryRun ? "none" : "prd",
          env: request.releaseVersion != null ? { RELEASE_VERSION: request.releaseVersion } : undefined,
        }],
      };
    },
  };
}

export function createPreviewWranglerConfig({
  baseConfig,
  lane,
  emailFrom,
}: {
  readonly baseConfig: WranglerPreviewBaseConfig;
  readonly lane: CloudflarePreviewLane;
  readonly emailFrom?: string;
}): Record<string, unknown> {
  return {
    $schema: baseConfig.$schema,
    name: lane.workerName,
    main: baseConfig.main,
    compatibility_date: baseConfig.compatibility_date,
    ...(baseConfig.compatibility_flags != null ? { compatibility_flags: baseConfig.compatibility_flags } : {}),
    ...(baseConfig.assets != null ? { assets: baseConfig.assets } : {}),
    ...(baseConfig.observability != null ? { observability: baseConfig.observability } : {}),
    ...(baseConfig.vars != null ? { vars: baseConfig.vars } : {}),
    routes: [{ pattern: lane.hostname, custom_domain: true }],
    ...(emailFrom != null ? { send_email: [{ name: "EMAIL", allowed_sender_addresses: [emailFrom] }] } : {}),
  };
}
