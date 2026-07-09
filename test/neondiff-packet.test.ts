import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  buildNeonDiffRepoWikiPacket,
  exportNeonDiffRepoWikiPacketJson,
} from "../src/neondiff-packet.ts";

const execFileAsync = promisify(execFile);
const generatedAt = "2026-07-09T08:00:00.000Z";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepoWithOpenWiki(): Promise<{
  head: string;
  repo: string;
}> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-neondiff-packet-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "openwiki"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await writeFile(
    path.join(repo, "src", "index.ts"),
    "export const answer = 42;\n",
    "utf8",
  );
  await writeFile(
    path.join(repo, "openwiki", "quickstart.md"),
    [
      "# Quickstart",
      "",
      "This wiki explains the repo. Do not place OPENROUTER_API_KEY in prompts.",
      "",
      "## Source map",
      "",
      "- README.md",
      "- src/index.ts",
      "- Git evidence: commits `abc1234`",
      "",
    ].join("\n"),
    "utf8",
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(repo, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: generatedAt,
      command: "update",
      gitHead: head,
      model: "glm-5.2",
    })}\n`,
    "utf8",
  );
  return { head, repo };
}

describe("NeonDiff repo-wiki packet export", () => {
  test("exports OpenWiki markdown as a fresh NeonDiff-compatible packet", async () => {
    const { head, repo } = await createRepoWithOpenWiki();

    const packet = await buildNeonDiffRepoWikiPacket({
      cwd: repo,
      generatedAt,
      repo: "owner/repo",
    });

    expect(packet).toMatchObject({
      packetVersion: "repo-wiki-packet-v0.1",
      repo: { fullName: "owner/repo" },
      source: {
        headSha: head,
        status: "fresh",
      },
      degraded: false,
      redaction: {
        status: "redacted",
        replacementCount: 1,
      },
    });
    expect(packet.packetSha).toMatch(/^[a-f0-9]{64}$/u);
    expect(packet.includedSections).toHaveLength(1);
    expect(packet.includedSections[0]?.sourceFiles).toEqual([
      "README.md",
      "openwiki/quickstart.md",
      "src/index.ts",
    ]);
    expect(packet.includedSections[0]?.body).toContain("[redacted-secret]");
    expect(packet.includedSections[0]?.body).not.toContain(
      "OPENROUTER_API_KEY",
    );
    expect(packet.includedFiles).toContainEqual({
      path: "README.md",
      sections: ["quickstart"],
    });
  });

  test("marks packets stale when metadata does not match the current head", async () => {
    const { repo } = await createRepoWithOpenWiki();
    await writeFile(
      path.join(repo, "openwiki", ".last-update.json"),
      `${JSON.stringify({ gitHead: "different-head" })}\n`,
      "utf8",
    );

    const packet = await buildNeonDiffRepoWikiPacket({
      cwd: repo,
      generatedAt,
      repo: "owner/repo",
    });

    expect(packet.source).toMatchObject({
      status: "stale",
      staleReason:
        "OpenWiki metadata gitHead does not match the current repository head.",
    });
    expect(packet.degraded).toBe(true);
  });

  test("does not mark the standard NeonDiff packet artifact as stale source", async () => {
    const { head, repo } = await createRepoWithOpenWiki();
    await mkdir(path.join(repo, ".neondiff"), { recursive: true });
    await writeFile(
      path.join(repo, ".neondiff", "repo-wiki-packet.json"),
      "{}\n",
      "utf8",
    );

    const packet = await buildNeonDiffRepoWikiPacket({
      cwd: repo,
      generatedAt,
      repo: "owner/repo",
    });

    expect(packet.source).toMatchObject({
      headSha: head,
      status: "fresh",
    });
  });

  test("writes JSON only to explicit relative output paths", async () => {
    const { repo } = await createRepoWithOpenWiki();
    const outputPath = ".neondiff/repo-wiki-packet.json";

    const result = await exportNeonDiffRepoWikiPacketJson({
      cwd: repo,
      generatedAt,
      outputPath,
      repo: "owner/repo",
    });

    const written = await readFile(path.join(repo, outputPath), "utf8");
    expect(written).toBe(result.json);
    expect(JSON.parse(written)).toMatchObject({
      packetVersion: "repo-wiki-packet-v0.1",
    });
    await expect(
      exportNeonDiffRepoWikiPacketJson({
        cwd: repo,
        generatedAt,
        outputPath: "../packet.json",
        repo: "owner/repo",
      }),
    ).rejects.toThrow(/inside the current repository/u);
  });
});
