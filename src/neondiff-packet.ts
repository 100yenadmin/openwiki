import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { OPEN_WIKI_DIR, UPDATE_METADATA_PATH } from "./constants.js";

const execFileAsync = promisify(execFile);
const PACKET_VERSION = "repo-wiki-packet-v0.1";
const ADVISORY_LINE =
  "Repo wiki packet context is advisory. GitHub diff and checkout remain truth.";
const DEFAULT_MAX_PACKET_BYTES = 12_000;
const REDACTION = "[redacted-secret]";

type SourceStatus = "fresh" | "stale" | "missing";

export type NeonDiffPacketExportOptions = {
  cwd?: string;
  generatedAt?: string;
  maxBytes?: number;
  outputPath?: string | null;
  repo?: string | null;
};

export type NeonDiffRepoWikiPacket = {
  packetVersion: string;
  repo: {
    fullName: string;
    defaultBranch?: string;
    remoteUrl?: string;
  };
  source: {
    ref: string;
    headSha?: string;
    checkedAt?: string;
    status: SourceStatus;
    staleReason?: string;
  };
  generatedAt: string;
  advisory: string;
  degraded: boolean;
  byteBudget: {
    maxBytes: number;
    usedBytes: number;
  };
  tokenBudget: {
    maxTokens: number;
    usedTokens: number;
  };
  redaction: {
    status: "passed" | "redacted";
    replacementCount: number;
  };
  includedSections: Array<{
    id: string;
    title: string;
    body: string;
    order: number;
    sourceFiles: string[];
    sourceSha?: string;
    byteLength: number;
    tokenEstimate: number;
    truncated: boolean;
    redacted: boolean;
  }>;
  excludedSections: Array<{
    id: string;
    reason: "empty" | "missing_source" | "packet_budget_exceeded";
  }>;
  includedFiles: Array<{
    path: string;
    sections: string[];
  }>;
  packetSha: string;
};

type OpenWikiSection = {
  id: string;
  title: string;
  body: string;
  order: number;
  sourceFiles: string[];
};

type RedactionCounter = {
  count: number;
};

type LastUpdateMetadata = {
  gitHead?: string;
};

export async function exportNeonDiffRepoWikiPacketJson(
  options: NeonDiffPacketExportOptions = {},
): Promise<{ json: string; packet: NeonDiffRepoWikiPacket }> {
  const cwd = options.cwd ?? process.cwd();
  const packet = await buildNeonDiffRepoWikiPacket({
    cwd,
    generatedAt: options.generatedAt,
    maxBytes: options.maxBytes,
    repo: options.repo,
  });
  const json = `${canonicalStringify(packet)}\n`;

  if (options.outputPath) {
    const outputPath = resolveRelativeOutputPath(cwd, options.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, "utf8");
  }

  return { json, packet };
}

export async function buildNeonDiffRepoWikiPacket(
  options: Omit<NeonDiffPacketExportOptions, "outputPath"> = {},
): Promise<NeonDiffRepoWikiPacket> {
  const cwd = options.cwd ?? process.cwd();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  assertCanonicalIsoTimestamp(generatedAt, "generatedAt");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PACKET_BYTES;
  assertPositiveInteger(maxBytes, "maxBytes");

  const counter: RedactionCounter = { count: 0 };
  const repo = await resolveRepoIdentity(cwd, options.repo ?? null, counter);
  const gitHead = await git(cwd, ["rev-parse", "HEAD"]).catch(() => null);
  const defaultBranch = await resolveDefaultBranch(cwd);
  const metadata = await readLastUpdateMetadata(cwd);
  const sections = await readOpenWikiSections(cwd);
  const source = await buildSourceFreshness({
    cwd,
    defaultBranch,
    generatedAt,
    gitHead,
    metadata,
    sectionCount: sections.length,
  });
  const maxTokens = tokenEstimateForBytes(maxBytes);
  const maxSectionBytes = Math.max(
    800,
    Math.floor(maxBytes / Math.max(2, sections.length || 1)),
  );
  const includedSections = sections.map((section) => {
    const title = redactAndCount(section.title, counter);
    const body = redactAndCount(section.body, counter);
    const sourceFiles = normalizeSourceFiles(
      section.sourceFiles.map((file) => redactAndCount(file, counter).text),
    );
    const cappedBody = truncateUtf8Bytes(body.text, maxSectionBytes);
    const byteLength = Buffer.byteLength(cappedBody, "utf8");

    return {
      id: section.id,
      title: title.text,
      body: cappedBody,
      order: section.order,
      sourceFiles,
      byteLength,
      tokenEstimate: tokenEstimateForBytes(byteLength),
      truncated: cappedBody !== body.text,
      redacted:
        title.replacementCount > 0 ||
        body.replacementCount > 0 ||
        sourceFiles.some((file) => file.includes(REDACTION)),
    };
  });
  const excludedSections =
    sections.length === 0
      ? [{ id: "packet:sections", reason: "missing_source" as const }]
      : [];
  const base = {
    packetVersion: PACKET_VERSION,
    repo,
    source: redactSource(source, counter),
    generatedAt,
    advisory: ADVISORY_LINE,
    degraded: source.status !== "fresh",
    byteBudget: { maxBytes, usedBytes: 0 },
    tokenBudget: { maxTokens, usedTokens: 0 },
    redaction: {
      status: counter.count > 0 ? "redacted" : "passed",
      replacementCount: counter.count,
    },
  } satisfies Omit<
    NeonDiffRepoWikiPacket,
    "includedSections" | "excludedSections" | "includedFiles" | "packetSha"
  >;

  return finalizePacket(base, includedSections, excludedSections);
}

function resolveRelativeOutputPath(cwd: string, outputPath: string): string {
  const normalized = outputPath.trim();
  if (!normalized) {
    throw new Error("--output must be a non-empty relative path.");
  }
  if (
    path.isAbsolute(normalized) ||
    normalized.split(/[\\/]+/u).includes("..")
  ) {
    throw new Error("--output must stay inside the current repository.");
  }
  return path.resolve(cwd, normalized);
}

async function resolveRepoIdentity(
  cwd: string,
  repoOverride: string | null,
  counter: RedactionCounter,
): Promise<NeonDiffRepoWikiPacket["repo"]> {
  const remoteUrl = await git(cwd, ["remote", "get-url", "origin"]).catch(
    () => null,
  );
  const fullName = repoOverride ?? parseGitHubRepo(remoteUrl ?? "");

  if (!fullName) {
    throw new Error(
      "Could not infer repository owner/name from origin. Pass --repo <owner/repo>.",
    );
  }
  assertRepoName(fullName);

  const defaultBranch = await resolveDefaultBranch(cwd);

  return {
    fullName: redactAndCount(fullName, counter).text,
    ...(defaultBranch
      ? { defaultBranch: redactAndCount(defaultBranch, counter).text }
      : {}),
    ...(remoteUrl
      ? { remoteUrl: redactAndCount(remoteUrl, counter).text }
      : {}),
  };
}

async function resolveDefaultBranch(cwd: string): Promise<string | undefined> {
  const originHead = await git(cwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]).catch(() => null);
  if (originHead?.startsWith("origin/"))
    return originHead.slice("origin/".length);

  const current = await git(cwd, ["branch", "--show-current"]).catch(
    () => null,
  );
  return current || undefined;
}

function parseGitHubRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/u, "");
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/u);
  if (httpsMatch) return httpsMatch[1] ?? null;
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/u);
  if (sshMatch) return sshMatch[1] ?? null;
  return null;
}

async function buildSourceFreshness(input: {
  cwd: string;
  defaultBranch?: string;
  generatedAt: string;
  gitHead: string | null;
  metadata: LastUpdateMetadata | null;
  sectionCount: number;
}): Promise<NeonDiffRepoWikiPacket["source"]> {
  const dirtyNonOpenWikiPaths = await readDirtyNonOpenWikiPaths(input.cwd);
  const base = {
    ref: input.defaultBranch ?? "HEAD",
    ...(input.gitHead ? { headSha: input.gitHead } : {}),
    checkedAt: input.generatedAt,
  };

  if (input.sectionCount === 0) {
    return {
      ...base,
      status: "missing",
      staleReason: "No OpenWiki Markdown files were found under openwiki/.",
    };
  }

  if (dirtyNonOpenWikiPaths.length > 0) {
    return {
      ...base,
      status: "stale",
      staleReason:
        "Repository has non-openwiki worktree changes; regenerate OpenWiki before exporting prompt context.",
    };
  }

  if (!input.metadata?.gitHead) {
    return {
      ...base,
      status: "stale",
      staleReason: "openwiki/.last-update.json does not record a gitHead.",
    };
  }

  if (input.gitHead && input.metadata.gitHead === input.gitHead) {
    return {
      ...base,
      status: "fresh",
    };
  }

  return {
    ...base,
    status: "stale",
    staleReason:
      "OpenWiki metadata gitHead does not match the current repository head.",
  };
}

async function readDirtyNonOpenWikiPaths(cwd: string): Promise<string[]> {
  const status = await git(cwd, ["status", "--porcelain"]).catch(() => "");

  return status
    .split(/\r?\n/u)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .filter((changedPath) => {
      const normalized = changedPath.replace(/\\/gu, "/");
      return (
        normalized !== OPEN_WIKI_DIR &&
        !normalized.startsWith(`${OPEN_WIKI_DIR}/`)
      );
    });
}

async function readLastUpdateMetadata(
  cwd: string,
): Promise<LastUpdateMetadata | null> {
  try {
    const raw = await readFile(path.join(cwd, UPDATE_METADATA_PATH), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const gitHead = (parsed as { gitHead?: unknown }).gitHead;
    return typeof gitHead === "string" ? { gitHead } : {};
  } catch {
    return null;
  }
}

async function readOpenWikiSections(cwd: string): Promise<OpenWikiSection[]> {
  const root = path.join(cwd, OPEN_WIKI_DIR);
  const files = await listMarkdownFiles(root, cwd).catch(() => []);
  const sections: OpenWikiSection[] = [];

  for (const [index, filePath] of files.entries()) {
    const body = await readFile(path.join(cwd, filePath), "utf8");
    const title = readFirstHeading(body) ?? filePath;
    sections.push({
      id: normalizeSectionId(
        filePath.replace(/^openwiki\//u, "").replace(/\.md$/u, ""),
      ),
      title,
      body: body.trim(),
      order: index,
      sourceFiles: normalizeSourceFiles([filePath, ...readSourceMap(body)]),
    });
  }

  return sections;
}

async function listMarkdownFiles(dir: string, cwd: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
    if (
      relativePath === `${OPEN_WIKI_DIR}/_review` ||
      relativePath.startsWith(`${OPEN_WIKI_DIR}/_review/`)
    ) {
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...(await listMarkdownFiles(absolutePath, cwd)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const fileStat = await stat(absolutePath);
      if (fileStat.size > 256_000) continue;
      results.push(relativePath);
    }
  }

  return results.sort(codeUnitCompare);
}

function readFirstHeading(markdown: string): string | undefined {
  const heading = markdown
    .split(/\r?\n/u)
    .find((line) => /^#\s+\S/u.test(line));
  return heading?.replace(/^#\s+/u, "").trim();
}

function readSourceMap(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/u);
  const paths: string[] = [];
  let inSourceMap = false;

  for (const line of lines) {
    if (/^##\s+Source map\s*$/iu.test(line.trim())) {
      inSourceMap = true;
      continue;
    }
    if (inSourceMap && /^##\s+/u.test(line.trim())) break;
    if (!inSourceMap) continue;

    const match = line.match(/^\s*-\s+(.+)$/u);
    if (!match) continue;
    const item = match[1]?.trim() ?? "";
    if (/^Git evidence:/iu.test(item)) continue;

    for (const candidate of item.split(/,\s*/u)) {
      const cleaned = candidate.replace(/[`"'<>]/gu, "").trim();
      if (isLikelyRepoPath(cleaned)) paths.push(cleaned);
    }
  }

  return normalizeSourceFiles(paths);
}

function isLikelyRepoPath(value: string): boolean {
  if (!value || /\s/u.test(value)) return false;
  if (/^[a-f0-9]{7,40}$/iu.test(value)) return false;
  if (/^[a-z]+:\/\//iu.test(value)) return false;
  return value.includes("/") || value.includes(".");
}

function finalizePacket(
  base: Omit<
    NeonDiffRepoWikiPacket,
    "includedSections" | "excludedSections" | "includedFiles" | "packetSha"
  >,
  inputSections: NeonDiffRepoWikiPacket["includedSections"],
  inputExcluded: NeonDiffRepoWikiPacket["excludedSections"],
): NeonDiffRepoWikiPacket {
  const includedSections = [...inputSections];
  let excludedSections = [...inputExcluded];

  while (true) {
    const packet = finalizePacketSize(base, includedSections, excludedSections);
    if (
      packet.byteBudget.usedBytes <= packet.byteBudget.maxBytes &&
      packet.tokenBudget.usedTokens <= packet.tokenBudget.maxTokens
    ) {
      return packet;
    }

    const dropped = includedSections.pop();
    if (!dropped) return packet;
    excludedSections = [
      { id: dropped.id, reason: "packet_budget_exceeded" },
      ...excludedSections,
    ];
  }
}

function finalizePacketSize(
  base: Omit<
    NeonDiffRepoWikiPacket,
    "includedSections" | "excludedSections" | "includedFiles" | "packetSha"
  >,
  includedSections: NeonDiffRepoWikiPacket["includedSections"],
  excludedSections: NeonDiffRepoWikiPacket["excludedSections"],
): NeonDiffRepoWikiPacket {
  let packetWithoutSha: Omit<NeonDiffRepoWikiPacket, "packetSha"> = {
    ...base,
    includedSections,
    excludedSections: [...excludedSections].sort(compareExcluded),
    includedFiles: buildIncludedFiles(includedSections),
  };
  let packetSha = sha256(canonicalStringify(packetWithoutSha));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const packet = { ...packetWithoutSha, packetSha };
    const usedBytes = Buffer.byteLength(formatPacketMarkdown(packet), "utf8");
    const usedTokens = tokenEstimateForBytes(usedBytes);
    const nextPacketWithoutSha = {
      ...packetWithoutSha,
      byteBudget: { ...packetWithoutSha.byteBudget, usedBytes },
      tokenBudget: { ...packetWithoutSha.tokenBudget, usedTokens },
    };
    const nextSha = sha256(canonicalStringify(nextPacketWithoutSha));
    if (
      usedBytes === packetWithoutSha.byteBudget.usedBytes &&
      usedTokens === packetWithoutSha.tokenBudget.usedTokens
    ) {
      return { ...nextPacketWithoutSha, packetSha: nextSha };
    }
    packetWithoutSha = nextPacketWithoutSha;
    packetSha = nextSha;
  }

  return { ...packetWithoutSha, packetSha };
}

function formatPacketMarkdown(packet: NeonDiffRepoWikiPacket): string {
  const lines = [
    "# Repo Wiki Packet",
    "",
    `Repository: ${packet.repo.fullName}`,
    packet.repo.defaultBranch
      ? `Default branch: ${packet.repo.defaultBranch}`
      : undefined,
    `Source ref: ${packet.source.ref}`,
    packet.source.headSha ? `Source head: ${packet.source.headSha}` : undefined,
    `Source status: ${packet.source.status}`,
    packet.source.staleReason
      ? `Source note: ${packet.source.staleReason}`
      : undefined,
    `Generated at: ${packet.generatedAt}`,
    `Packet SHA: ${packet.packetSha}`,
    `Budget: ${packet.byteBudget.usedBytes}/${packet.byteBudget.maxBytes} bytes; ${packet.tokenBudget.usedTokens}/${packet.tokenBudget.maxTokens} token-ish`,
    `Redaction: ${packet.redaction.status} (${packet.redaction.replacementCount} replacements)`,
    packet.degraded ? "Degraded: true" : "Degraded: false",
    "",
    packet.advisory,
    "",
  ].filter((line): line is string => line !== undefined);

  if (packet.includedSections.length === 0) {
    lines.push("## Sections", "", "No repo wiki sections were included.");
  } else {
    lines.push("## Sections");
    for (const section of packet.includedSections) {
      lines.push(
        "",
        `### ${section.title}`,
        "",
        [
          `id=${section.id}`,
          `bytes=${section.byteLength}`,
          `tokens=${section.tokenEstimate}`,
          section.truncated ? "truncated=true" : "truncated=false",
          section.redacted ? "redacted=true" : "redacted=false",
          section.sourceSha ? `source_sha=${section.sourceSha}` : undefined,
          section.sourceFiles.length
            ? `files=${section.sourceFiles.join(", ")}`
            : undefined,
        ]
          .filter(Boolean)
          .join("; "),
        "",
        section.body,
      );
    }
  }

  if (packet.excludedSections.length) {
    lines.push("", "## Excluded Sections");
    for (const section of packet.excludedSections) {
      lines.push("", `- ${section.id}: ${section.reason}`);
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

function buildIncludedFiles(
  sections: NeonDiffRepoWikiPacket["includedSections"],
): NeonDiffRepoWikiPacket["includedFiles"] {
  const byPath = new Map<string, Set<string>>();

  for (const section of sections) {
    for (const sourceFile of section.sourceFiles) {
      const ids = byPath.get(sourceFile) ?? new Set<string>();
      ids.add(section.id);
      byPath.set(sourceFile, ids);
    }
  }

  return [...byPath.entries()]
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([sourcePath, sectionIds]) => ({
      path: sourcePath,
      sections: [...sectionIds].sort(codeUnitCompare),
    }));
}

function redactSource(
  source: NeonDiffRepoWikiPacket["source"],
  counter: RedactionCounter,
): NeonDiffRepoWikiPacket["source"] {
  return {
    ref: redactAndCount(source.ref, counter).text,
    ...(source.headSha
      ? { headSha: redactAndCount(source.headSha, counter).text }
      : {}),
    ...(source.checkedAt ? { checkedAt: source.checkedAt } : {}),
    status: source.status,
    ...(source.staleReason
      ? { staleReason: redactAndCount(source.staleReason, counter).text }
      : {}),
  };
}

function redactAndCount(
  input: string,
  counter: RedactionCounter,
): { text: string; replacementCount: number } {
  const result = redactSecrets(input);
  counter.count += result.replacementCount;
  return result;
}

function redactSecrets(input: string): {
  text: string;
  replacementCount: number;
} {
  let replacementCount = 0;
  const patterns = [
    /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION|PRIVATE_KEY)[A-Z0-9_]*\b/gu,
    /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/gu,
    /\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu,
    /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/giu,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/giu,
    /[?&](?:access[_-]?token|auth[_-]?token|api[_-]?key|token|secret|session|cookie)=[A-Za-z0-9._~+/=-]{16,}/giu,
    /\b(?:api[_-]?key|token|secret|password|cookie|session)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/giu,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/gu,
  ];

  const text = patterns.reduce(
    (current, pattern) =>
      current.replace(pattern, () => {
        replacementCount += 1;
        return REDACTION;
      }),
    input,
  );

  return { text, replacementCount };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function normalizeSectionId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "section";
}

function normalizeSourceFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort(
    codeUnitCompare,
  );
}

function truncateUtf8Bytes(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let output = "";
  let usedBytes = 0;
  for (const char of input) {
    const nextBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + nextBytes > maxBytes) break;
    output += char;
    usedBytes += nextBytes;
  }
  return output;
}

function tokenEstimateForBytes(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 4));
}

function assertRepoName(repo: string): void {
  const [owner, name, extra] = repo.split("/");
  if (extra !== undefined || !owner || !name) {
    throw new Error("--repo must be an owner/repo name.");
  }
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(name)) {
    throw new Error("--repo must be an owner/repo name.");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertCanonicalIsoTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
}

function compareExcluded(
  left: NeonDiffRepoWikiPacket["excludedSections"][number],
  right: NeonDiffRepoWikiPacket["excludedSections"][number],
): number {
  const id = codeUnitCompare(left.id, right.id);
  return id !== 0 ? id : codeUnitCompare(left.reason, right.reason);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalStringify(input: unknown): string {
  return JSON.stringify(sortJson(input));
}

function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => sortJson(item));
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => codeUnitCompare(left, right))
        .map(([key, value]) => [key, sortJson(value)]),
    );
  }
  return input;
}

function codeUnitCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
