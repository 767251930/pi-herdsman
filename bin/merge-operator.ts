#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  effectiveMergePolicy,
  readConfig,
  setManagerMergeOverride,
} from "../extension/config.ts";

function usage(): never {
  throw new TypeError(
    "Usage: pi-herdsman merge <allow|clear> --repo <absolute-primary-checkout>",
  );
}

function parseArgs(args: string[]): {
  action: "allow" | "clear";
  repo: string;
} {
  if (
    args.length !== 4 ||
    args[0] !== "merge" ||
    (args[1] !== "allow" && args[1] !== "clear") ||
    args[2] !== "--repo" ||
    !isAbsolute(args[3]!)
  )
    usage();
  return { action: args[1], repo: args[3] };
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function verifiedRepoKey(repoPath: string): string {
  const repo = realpathSync(resolve(repoPath));
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "rev-parse", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv,
    }).trim();

  if (git("--is-inside-work-tree") !== "true")
    throw new Error("Expected a Git working tree");
  if (git("--show-prefix") !== "")
    throw new Error("Expected the checkout root");

  const gitDir = realpathSync(git("--path-format=absolute", "--git-dir"));
  const commonDir = realpathSync(
    git("--path-format=absolute", "--git-common-dir"),
  );
  if (!samePath(gitDir, commonDir))
    throw new Error("Expected a primary checkout, not a linked worktree");
  return commonDir;
}

export async function confirmEnable(
  repoKey: string,
  isTTY: boolean,
  ask: (prompt: string) => Promise<string>,
): Promise<void> {
  if (!isTTY) throw new Error("Authorization requires an interactive terminal");
  const answer = await ask(
    `Type enable to authorize Manager local merging for ${repoKey}: `,
  );
  if (answer !== "enable") throw new Error("Authorization not confirmed");
}

async function main(args: string[]): Promise<void> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const repoKey = verifiedRepoKey(options.repo);
    if (options.action === "allow") {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        await confirmEnable(repoKey, process.stdin.isTTY, (message) =>
          prompt.question(message),
        );
      } finally {
        prompt.close();
      }
      setManagerMergeOverride(repoKey, true);
      const policy = effectiveMergePolicy(readConfig(), repoKey);
      if (!policy.enabled || policy.source !== "repository")
        throw new Error("Could not verify repository-specific authorization");
      process.stdout.write(`Manager local merging enabled for ${repoKey}.\n`);
      return;
    }

    setManagerMergeOverride(repoKey, undefined);
    if (Object.hasOwn(readConfig().managerMergeOverrides, repoKey))
      throw new Error("Could not verify repository override removal");
    process.stdout.write(
      `Repository override cleared for ${repoKey}; the global policy is inherited.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
