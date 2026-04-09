import { createSign } from "node:crypto";

export interface GitHubAuthProvider {
  mode: "app" | "token";
  getTokenForRepo(repoFullName: string): Promise<string>;
}

interface InstallationTokenCacheEntry {
  token: string;
  expiresAtMs: number;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId
  });
  const unsigned = `${header}.${payload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey, "base64url");

  return `${unsigned}.${signature}`;
}

class StaticTokenAuthProvider implements GitHubAuthProvider {
  mode: "token" = "token";

  constructor(private readonly token: string) {}

  async getTokenForRepo(_repoFullName: string): Promise<string> {
    return this.token;
  }
}

class GitHubAppAuthProvider implements GitHubAuthProvider {
  mode: "app" = "app";
  private readonly installationByRepo = new Map<string, number>();
  private readonly tokenByInstallation = new Map<number, InstallationTokenCacheEntry>();

  constructor(
    private readonly appId: string,
    private readonly privateKey: string,
    private readonly githubApiBase: string
  ) {}

  private async requestAsApp<T>(path: string, init?: RequestInit): Promise<T> {
    const appJwt = createGitHubAppJwt(this.appId, this.privateKey);
    const response = await fetch(`${this.githubApiBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "agent-factory-github-app-auth",
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub App request failed (${response.status}) ${path}: ${body}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async resolveInstallationId(repoFullName: string): Promise<number> {
    const key = repoFullName.toLowerCase();
    const cached = this.installationByRepo.get(key);
    if (cached) {
      return cached;
    }

    const response = await this.requestAsApp<{ id: number }>(`/repos/${repoFullName}/installation`, {
      method: "GET"
    });
    this.installationByRepo.set(key, response.id);
    return response.id;
  }

  private async createInstallationToken(installationId: number): Promise<InstallationTokenCacheEntry> {
    const response = await this.requestAsApp<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );

    return {
      token: response.token,
      expiresAtMs: new Date(response.expires_at).getTime()
    };
  }

  async getTokenForRepo(repoFullName: string): Promise<string> {
    const installationId = await this.resolveInstallationId(repoFullName);
    const cached = this.tokenByInstallation.get(installationId);
    if (cached && cached.expiresAtMs - Date.now() > 60_000) {
      return cached.token;
    }

    const refreshed = await this.createInstallationToken(installationId);
    this.tokenByInstallation.set(installationId, refreshed);
    return refreshed.token;
  }
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export function createGitHubAuthProviderFromEnv(options?: {
  requireProvider?: boolean;
  githubApiBase?: string;
}): GitHubAuthProvider | undefined {
  const githubApiBase = options?.githubApiBase ?? process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";

  const appId = process.env.GITHUB_APP_ID?.trim();
  const appPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (appId && appPrivateKey) {
    return new GitHubAppAuthProvider(appId, normalizePrivateKey(appPrivateKey), githubApiBase);
  }

  const staticToken = (process.env.GITHUB_BOT_TOKEN ?? process.env.GH_TOKEN)?.trim();
  if (staticToken && staticToken.length > 0) {
    return new StaticTokenAuthProvider(staticToken);
  }

  if (options?.requireProvider) {
    throw new Error("configure GitHub auth via GITHUB_APP_ID+GITHUB_APP_PRIVATE_KEY or GITHUB_BOT_TOKEN/GH_TOKEN");
  }

  return undefined;
}
