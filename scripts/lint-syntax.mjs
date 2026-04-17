import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ignoredDirectories = new Set([".git", ".next", "coverage", "dist", "node_modules"]);
const checkedExtensions = new Set([".cjs", ".js", ".mjs", ".ts"]);

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) {
      continue;
    }

    const path = join(directory, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      yield* walk(path);
      continue;
    }

    const extension = entry.slice(entry.lastIndexOf("."));
    if (checkedExtensions.has(extension)) {
      yield path;
    }
  }
}

const files = [...walk(process.cwd())];
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--experimental-transform-types", "--check", file], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Syntax lint passed for ${files.length} files.`);
