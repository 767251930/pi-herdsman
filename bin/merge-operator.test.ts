import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { confirmEnable } from "./merge-operator.ts";

const cli = new URL("./merge-operator.ts", import.meta.url).pathname;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

function initRepo(path: string): void {
  mkdirSync(path);
  git(path, "init", "-q");
  git(path, "config", "user.email", "test@example.invalid");
  git(path, "config", "user.name", "Test");
  writeFileSync(join(path, "file"), "test\n");
  git(path, "add", "file");
  git(path, "commit", "-qm", "initial");
}

test("merge operator validates primary repositories and scopes verified config", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-merge-operator-"));
  const agentDir = join(root, "agent");
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  const linked = join(root, "linked");
  const notRepo = join(root, "not-repo");
  const bare = join(root, "bare.git");
  const nested = join(repoA, "nested");
  mkdirSync(agentDir);
  mkdirSync(notRepo);
  initRepo(repoA);
  initRepo(repoB);
  mkdirSync(nested);
  git(root, "init", "--bare", "-q", bare);
  git(repoA, "worktree", "add", "-qb", "linked", linked);
  const keyA = git(
    repoA,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const keyB = git(
    repoB,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const configPath = join(agentDir, "pi-herdsman", "config.json");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env,
      input: "",
    });
  try {
    const usage = run(["merge", "allow", "--repo", repoA, "extra"]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/);
    assert.equal(run(["merge", "allow", "--repo", "relative"]).status, 2);
    assert.equal(run(["merge", "allow", "--yes", repoA]).status, 2);

    for (const invalid of [linked, notRepo, bare, nested]) {
      const result = run(["merge", "clear", "--repo", invalid]);
      assert.equal(result.status, 1, result.stderr);
    }
    const nonTty = run(["merge", "allow", "--repo", repoA]);
    assert.equal(nonTty.status, 1);
    assert.match(nonTty.stderr, /interactive terminal/);
    assert.equal(existsSync(configPath), false);

    mkdirSync(join(agentDir, "pi-herdsman"), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify({ managerMergeEnabled: true, managerMergeOverrides: { [keyA]: true, [keyB]: false } }, null, 2)}\n`,
    );
    const cleared = run(["merge", "clear", "--repo", repoA]);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cleared.stdout, /global policy is inherited/);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      managerMergeEnabled: true,
      managerMergeOverrides: { [keyB]: false },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merge authorization requires a TTY and the exact named confirmation", async () => {
  const prompts: string[] = [];
  const ask = async (prompt: string) => {
    prompts.push(prompt);
    return "enable";
  };
  await assert.rejects(
    confirmEnable("/canonical/repo", false, ask),
    /interactive terminal/,
  );
  assert.deepEqual(prompts, []);
  await confirmEnable("/canonical/repo", true, ask);
  assert.deepEqual(prompts, [
    "Type enable to authorize Manager local merging for /canonical/repo: ",
  ]);
  await assert.rejects(
    confirmEnable("/canonical/repo", true, async () => "ENABLE"),
    /not confirmed/,
  );
});
