import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { confirmEnable } from "./merge-operator.ts";

const cli = fileURLToPath(new URL("./merge-operator.ts", import.meta.url));

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
  const keyA = realpathSync(
    git(repoA, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const keyB = realpathSync(
    git(repoB, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const configPath = join(agentDir, "pi-herdsman", "config.json");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...env, ...extraEnv },
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
    if (process.platform === "win32") {
      const differentlyCased = run([
        "merge",
        "allow",
        "--repo",
        repoA.toUpperCase(),
      ]);
      assert.equal(differentlyCased.status, 1);
      assert.match(differentlyCased.stderr, /interactive terminal/);
    }

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

    writeFileSync(
      configPath,
      `${JSON.stringify({ managerMergeOverrides: { [keyA]: true, [keyB]: false } })}\n`,
    );
    const redirected = run(["merge", "clear", "--repo", repoA], {
      GIT_DIR: join(repoB, ".git"),
      GIT_WORK_TREE: repoA,
    });
    assert.equal(redirected.status, 0, redirected.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      managerMergeOverrides: { [keyB]: false },
    });

    if (process.platform === "win32") {
      writeFileSync(
        configPath,
        `${JSON.stringify({ managerMergeOverrides: { [keyA]: true, [keyB]: false } })}\n`,
      );
      const differentlyCasedRedirected = run(
        ["merge", "clear", "--repo", repoA],
        {
          git_dir: join(repoB, ".git"),
          git_work_tree: repoA,
        },
      );
      assert.equal(
        differentlyCasedRedirected.status,
        0,
        differentlyCasedRedirected.stderr,
      );
      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
        managerMergeOverrides: { [keyB]: false },
      });
    }
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

test("packaged merge CLI runs through an npm-style symlink only as the entry point", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-merge-package-"));
  const binDir = join(root, "node_modules", ".bin");
  const packageCli = join(process.cwd(), "dist", "merge-operator.js");
  mkdirSync(binDir, { recursive: true });
  try {
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    symlinkSync(packageCli, join(binDir, "pi-herdsman"), "file");

    const invoked = spawnSync(process.execPath, [join(binDir, "pi-herdsman")], {
      encoding: "utf8",
    });
    assert.equal(invoked.status, 2, invoked.stderr);
    assert.match(invoked.stderr, /Usage:/);

    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(packageCli).href)})`,
        "invalid",
      ],
      { encoding: "utf8" },
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
