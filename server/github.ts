import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { SafeError } from "./domain.ts";

export interface InstallationInfo {
  id: number;
  accountId: number;
  accountLogin: string;
  repositorySelection: string;
}

export interface RepositoryInfo {
  id: number;
  fullName: string;
  private: boolean;
  archived: boolean;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  author: string;
  url: string;
  state: "open" | "closed";
  draft: boolean;
  headSha: string;
  baseSha: string;
  openedAt: string;
}

export interface ChangedFile {
  path: string;
  status: string;
  patch?: string;
  previousPath?: string;
}

export interface ReviewRef {
  id: number;
  body: string;
}

export interface ReviewCommentRef {
  id: number;
  url: string;
  body: string;
}

export interface NewReview {
  commitSha: string;
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
}

export interface RepoRef {
  installationId: number;
  owner: string;
  repo: string;
}

/** Everything Reviewgate needs from GitHub. Tests supply a controlled fake. */
export interface GitHubGateway {
  listInstallations(): Promise<InstallationInfo[]>;
  listRepositories(installationId: number): Promise<RepositoryInfo[]>;
  listOpenPullRequests(ref: RepoRef): Promise<PullRequestInfo[]>;
  getPullRequest(ref: RepoRef, number: number): Promise<PullRequestInfo | null>;
  listChangedFiles(
    ref: RepoRef,
    number: number,
    limit: number,
  ): Promise<{ files: ChangedFile[]; truncated: boolean }>;
  /** Returns null for missing, oversized, or non-file content. */
  getFileContent(ref: RepoRef, path: string, sha: string): Promise<string | null>;
  listReviews(ref: RepoRef, number: number): Promise<ReviewRef[]>;
  listReviewComments(ref: RepoRef, number: number, reviewId: number): Promise<ReviewCommentRef[]>;
  createReview(ref: RepoRef, number: number, review: NewReview): Promise<{ id: number }>;
}

/** Largest file the gateway will decode for review context. */
export const MAX_FILE_BYTES = 150_000;

const PAGE_SIZE = 100;

export function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error("Invalid repository name");
  return { owner, repo };
}

function toSafeError(error: unknown): unknown {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401 || status === 403) {
    const rateLimited = /rate limit/i.test((error as Error).message ?? "");
    return new SafeError(rateLimited ? "GITHUB_RATE_LIMITED" : "GITHUB_ACCESS_DENIED", rateLimited);
  }
  if (status === 404) return new SafeError("GITHUB_NOT_FOUND");
  if (status === 429) return new SafeError("GITHUB_RATE_LIMITED", true);
  return error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toSafeError(error);
  }
}

function mapPullRequest(pr: {
  number: number;
  title: string;
  user: { login: string } | null;
  html_url: string;
  state: string;
  draft?: boolean;
  head: { sha: string };
  base: { sha: string };
  created_at: string;
}): PullRequestInfo {
  return {
    number: pr.number,
    title: pr.title,
    author: pr.user?.login ?? "unknown",
    url: pr.html_url,
    state: pr.state === "open" ? "open" : "closed",
    draft: pr.draft ?? false,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    openedAt: pr.created_at,
  };
}

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

/** Authenticates as the GitHub App, then as a short-lived installation. */
export class OctokitGateway implements GitHubGateway {
  private readonly appClient: Octokit;
  private readonly installationClients = new Map<number, Octokit>();

  constructor(private readonly credentials: GitHubAppCredentials) {
    this.appClient = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: credentials.appId, privateKey: credentials.privateKey },
    });
  }

  private client(installationId: number): Octokit {
    let client = this.installationClients.get(installationId);
    if (!client) {
      client = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: this.credentials.appId,
          privateKey: this.credentials.privateKey,
          installationId,
        },
      });
      this.installationClients.set(installationId, client);
    }
    return client;
  }

  listInstallations(): Promise<InstallationInfo[]> {
    return guarded(async () => {
      const installations = await this.appClient.paginate(this.appClient.apps.listInstallations, {
        per_page: PAGE_SIZE,
      });
      return installations.flatMap((installation) => {
        const account = installation.account;
        if (!account || !("login" in account)) return [];
        return [
          {
            id: installation.id,
            accountId: account.id,
            accountLogin: account.login,
            repositorySelection: installation.repository_selection,
          },
        ];
      });
    });
  }

  listRepositories(installationId: number): Promise<RepositoryInfo[]> {
    return guarded(async () => {
      const client = this.client(installationId);
      const repositories = await client.paginate(client.apps.listReposAccessibleToInstallation, {
        per_page: PAGE_SIZE,
      });
      return repositories.map((repository) => ({
        id: repository.id,
        fullName: repository.full_name,
        private: repository.private,
        archived: repository.archived ?? false,
      }));
    });
  }

  listOpenPullRequests(ref: RepoRef): Promise<PullRequestInfo[]> {
    return guarded(async () => {
      const client = this.client(ref.installationId);
      const pulls = await client.paginate(client.pulls.list, {
        owner: ref.owner,
        repo: ref.repo,
        state: "open",
        per_page: PAGE_SIZE,
      });
      return pulls.map(mapPullRequest);
    });
  }

  getPullRequest(ref: RepoRef, number: number): Promise<PullRequestInfo | null> {
    return guarded(async () => {
      try {
        const { data } = await this.client(ref.installationId).pulls.get({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: number,
        });
        return mapPullRequest(data);
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    });
  }

  listChangedFiles(
    ref: RepoRef,
    number: number,
    limit: number,
  ): Promise<{ files: ChangedFile[]; truncated: boolean }> {
    return guarded(async () => {
      const client = this.client(ref.installationId);
      const files: ChangedFile[] = [];
      let truncated = false;
      const pages = client.paginate.iterator(client.pulls.listFiles, {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: number,
        per_page: PAGE_SIZE,
      });
      for await (const page of pages) {
        for (const file of page.data) {
          if (files.length === limit) {
            truncated = true;
            break;
          }
          files.push({
            path: file.filename,
            status: file.status,
            patch: file.patch,
            previousPath: file.previous_filename,
          });
        }
        if (truncated) break;
      }
      return { files, truncated };
    });
  }

  getFileContent(ref: RepoRef, path: string, sha: string): Promise<string | null> {
    return guarded(async () => {
      try {
        const { data } = await this.client(ref.installationId).repos.getContent({
          owner: ref.owner,
          repo: ref.repo,
          path,
          ref: sha,
        });
        if (Array.isArray(data) || data.type !== "file") return null;
        if (data.size > MAX_FILE_BYTES || !data.content) return null;
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    });
  }

  listReviews(ref: RepoRef, number: number): Promise<ReviewRef[]> {
    return guarded(async () => {
      const client = this.client(ref.installationId);
      const reviews = await client.paginate(client.pulls.listReviews, {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: number,
        per_page: PAGE_SIZE,
      });
      return reviews.map((review) => ({ id: review.id, body: review.body ?? "" }));
    });
  }

  listReviewComments(ref: RepoRef, number: number, reviewId: number): Promise<ReviewCommentRef[]> {
    return guarded(async () => {
      const client = this.client(ref.installationId);
      const { data } = await client.pulls.listCommentsForReview({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: number,
        review_id: reviewId,
        per_page: PAGE_SIZE,
      });
      return data.map((comment) => ({
        id: comment.id,
        url: comment.html_url,
        body: comment.body,
      }));
    });
  }

  createReview(ref: RepoRef, number: number, review: NewReview): Promise<{ id: number }> {
    return guarded(async () => {
      const { data } = await this.client(ref.installationId).pulls.createReview({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: number,
        commit_id: review.commitSha,
        event: "COMMENT",
        body: review.body,
        comments: review.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: "RIGHT",
          body: comment.body,
        })),
      });
      return { id: data.id };
    });
  }
}

export function createGateway(credentials: {
  appId?: string;
  privateKey?: string;
}): GitHubGateway | null {
  if (!credentials.appId || !credentials.privateKey) return null;
  return new OctokitGateway({ appId: credentials.appId, privateKey: credentials.privateKey });
}
