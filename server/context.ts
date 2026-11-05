import { addedLines } from "./domain.ts";
import type { ChangedFile, GitHubGateway, RepoRef } from "./github.ts";

const MAX_IMPORT_CANDIDATES = 8;
const MAX_RELATED_FILES = 2;

const EXCLUDED_PATTERNS: RegExp[] = [
  // Environment, credential, and secret files
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)credentials?(\.[a-z]+)?$/i,
  /(^|\/)secrets?(\.[a-z]+)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg)$/i,
  /\.tfstate(\.|$)/i,
  /\.tfvars(\.json)?$/i,
  // Dependencies, build output, and coverage
  /(^|\/)(node_modules|vendor|dist|build|out|target|coverage|\.next|\.terraform)\//i,
  // Lockfiles
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|Gemfile\.lock|Cargo\.lock|go\.sum|composer\.lock)$/i,
  // Binary, media, and fonts
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|pdf|zip|gz|tgz|tar|7z|rar|exe|dll|so|dylib|bin|wasm|class|jar|mp3|mp4|mov|avi|webm|wav|ogg|woff2?|ttf|otf|eot)$/i,
  // Generated JavaScript
  /\.map$/i,
  /\.min\.(js|css)$/i,
  /[.-]bundle\.js$/i,
];

export function isExcludedPath(path: string): boolean {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(path));
}

const REDACTED = "[REDACTED]";

const TOKEN_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bsk_live_[A-Za-z0-9]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// Quoted literals always match. Unquoted values must look like a credential, not a
// code expression, so `password = input.value` is left alone.
const CREDENTIAL_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(?:(["'])[^"'\n]{8,}\2|(?=[^\s"',;]*\d)[A-Za-z0-9+/_=-]{8,}(?![.(\w]))/gi;

/**
 * Pattern-based defense. It does not guarantee that arbitrary secrets are found,
 * which is why known secret files are excluded before this runs.
 * Line counts are preserved so model line numbers stay meaningful.
 */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let result = text.replace(PRIVATE_KEY_BLOCK, (block) =>
    block
      .split("\n")
      .map((line) => `${/^[+\- ]/.test(line) ? line[0] : ""}${REDACTED}`)
      .join("\n"),
  );
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
  result = result.replace(CREDENTIAL_ASSIGNMENT, `$1${REDACTED}`);
  for (const secret of knownSecrets) {
    if (secret) result = result.replaceAll(secret, REDACTED);
  }
  return result;
}

const MARKER_PATTERN = /<!--\s*reviewgate:[\s\S]*?-->/gi;
const MENTION_PATTERN = /(^|[^\w`/])@([a-z0-9][a-z0-9-]*)/gim;

/** Cleans model text before it is stored or published on GitHub. */
export function sanitizeModelText(text: string, knownSecrets: readonly string[] = []): string {
  return redact(text, knownSecrets)
    .replace(MARKER_PATTERN, "")
    .replace(MENTION_PATTERN, "$1@​$2");
}

const SCRIPT_FILE = /\.(c|m)?(t|j)sx?$/i;
const TEST_FILE = /\.(test|spec)\.(c|m)?(t|j)sx?$/i;
const IMPORT_PATTERN =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

function normalizePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

/** Candidate paths for files related to a changed JS or TS file, most useful first. */
export function relatedCandidates(path: string, source: string): string[] {
  if (!SCRIPT_FILE.test(path)) return [];
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : path.slice(0, slash + 1);
  const fileName = path.slice(slash + 1);
  const candidates = new Set<string>();

  if (!TEST_FILE.test(path)) {
    const extension = /\.[^.]+$/.exec(fileName)?.[0] ?? "";
    const stem = fileName.slice(0, fileName.length - extension.length);
    candidates.add(`${directory}${stem}.test${extension}`);
    candidates.add(`${directory}${stem}.spec${extension}`);
    candidates.add(`${directory}__tests__/${stem}.test${extension}`);
  }

  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const base = normalizePath(`${directory}${match[1]}`);
    if (!base) continue;
    for (const suffix of RESOLVE_SUFFIXES) candidates.add(`${base}${suffix}`);
  }

  return [...candidates].filter((candidate) => !isExcludedPath(candidate)).slice(0, MAX_IMPORT_CANDIDATES);
}

export interface Coverage {
  filesChanged: number;
  filesReviewed: number;
  relatedFiles: number;
  excluded: string[];
  missingSource: string[];
  omittedDiffs: string[];
  contextLimited: string[];
  fileLimitReached: boolean;
  complete: boolean;
}

export interface ReviewContext {
  /** JSON so that file contents cannot break out of a delimiter. */
  serialized: string;
  coverage: Coverage;
  /** Added lines a finding may anchor to, keyed by path. */
  anchors: Map<string, Set<number>>;
}

export interface ContextRequest {
  github: GitHubGateway;
  ref: RepoRef;
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  maxFiles: number;
  maxBytes: number;
  knownSecrets?: readonly string[];
  /** Paths of earlier findings, fetched even when they left the latest diff. */
  priorPaths?: readonly string[];
}

interface Section {
  path: string;
  role: "changed" | "related" | "prior";
  status?: string;
  patch?: string;
  source?: string;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export async function buildContext(request: ContextRequest): Promise<ReviewContext> {
  const { github, ref, number, headSha, baseSha, maxFiles, maxBytes } = request;
  const secrets = request.knownSecrets ?? [];
  const { files, truncated } = await github.listChangedFiles(ref, number, maxFiles);

  const coverage: Coverage = {
    filesChanged: files.length,
    filesReviewed: 0,
    relatedFiles: 0,
    excluded: [],
    missingSource: [],
    omittedDiffs: [],
    contextLimited: [],
    fileLimitReached: truncated,
    complete: false,
  };
  const anchors = new Map<string, Set<number>>();
  const sections: Section[] = [];
  const included = new Set<string>();
  const envelope = {
    pullRequest: { title: redact(request.title, secrets), headSha, baseSha },
    files: [] as Section[],
  };
  let usedBytes = byteLength(envelope);

  const add = (section: Section): boolean => {
    const size = byteLength(section);
    if (usedBytes + size > maxBytes) return false;
    usedBytes += size;
    sections.push(section);
    included.add(section.path);
    return true;
  };

  const reviewable: Array<{ file: ChangedFile; source: string | null }> = [];
  for (const file of files) {
    if (isExcludedPath(file.path)) {
      coverage.excluded.push(file.path);
      continue;
    }
    const sha = file.status === "removed" ? baseSha : headSha;
    const source = await github.getFileContent(ref, file.path, sha);
    if (source === null) coverage.missingSource.push(file.path);
    if (file.patch === undefined) coverage.omittedDiffs.push(file.path);
    reviewable.push({ file, source });
  }

  for (const { file, source } of reviewable) {
    const patch = file.patch === undefined ? undefined : redact(file.patch, secrets);
    const redactedSource = source === null ? undefined : redact(source, secrets);
    const base: Section = { path: file.path, role: "changed", status: file.status };
    // Prefer diff plus source, then fall back to the diff alone.
    const added =
      add({ ...base, patch, source: redactedSource }) || (patch !== undefined && add({ ...base, patch }));
    if (!added) {
      coverage.contextLimited.push(file.path);
      continue;
    }
    if (patch !== undefined || redactedSource !== undefined) coverage.filesReviewed += 1;
    if (patch !== undefined && file.status !== "removed") {
      anchors.set(file.path, addedLines(file.patch));
    }
  }

  for (const { file, source } of reviewable) {
    if (source === null || file.status === "removed") continue;
    let found = 0;
    for (const candidate of relatedCandidates(file.path, source)) {
      if (found === MAX_RELATED_FILES) break;
      if (included.has(candidate)) continue;
      const content = await github.getFileContent(ref, candidate, headSha);
      if (content === null) continue;
      found += 1;
      if (add({ path: candidate, role: "related", source: redact(content, secrets) })) {
        coverage.relatedFiles += 1;
      } else {
        coverage.contextLimited.push(candidate);
      }
    }
  }

  for (const path of new Set(request.priorPaths ?? [])) {
    if (included.has(path) || isExcludedPath(path)) continue;
    const content = await github.getFileContent(ref, path, headSha);
    add({ path, role: "prior", ...(content === null ? {} : { source: redact(content, secrets) }) });
  }

  coverage.complete =
    !truncated &&
    coverage.missingSource.length === 0 &&
    coverage.omittedDiffs.length === 0 &&
    coverage.contextLimited.length === 0;

  return {
    serialized: JSON.stringify({ ...envelope, files: sections }),
    coverage,
    anchors,
  };
}
