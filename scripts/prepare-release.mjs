import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function checkVersion(tag, projectRoot = root) {
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(projectRoot, "src-tauri/tauri.conf.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8"));
  const cargo = readFileSync(join(projectRoot, "src-tauri/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1];
  if ([config.version, lock.version, lock.packages[""].version, cargo].some(v => v !== pkg.version)) {
    throw new Error("Package, lockfile, Tauri and Cargo versions must match");
  }
  if (tag?.startsWith("v") && tag !== `v${pkg.version}`) throw new Error(`Tag ${tag} does not match version ${pkg.version}`);
  return pkg.version;
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

export function prepareRelease(input, output, tag, repository, projectRoot = root) {
  const version = checkVersion(tag, projectRoot);
  if (tag !== `v${version}`) throw new Error("A matching release tag is required");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  const files = filesUnder(resolve(input));
  const outputPath = resolve(output);
  if (outputPath === resolve(input) || outputPath.startsWith(`${resolve(input)}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Release output must not be inside the input artifact directory");
  }
  const platforms = {};
  const assets = [
    [/-setup\.exe$/i, "Mason-windows-x64-setup.exe", "windows-x86_64"],
    [/\.app\.tar\.gz$/i, "Mason-macos-aarch64.app.tar.gz", "darwin-aarch64"],
    [/\.AppImage$/i, "Mason-linux-x86_64.AppImage", "linux-x86_64"],
    [/\.msi$/i, "Mason-windows-x64.msi"],
    [/\.dmg$/i, "Mason-macos-aarch64.dmg"],
    [/Mason\.zip$/i, "Mason-macos-aarch64.zip"],
    [/\.deb$/i, "Mason-linux-amd64.deb"],
    [/\.rpm$/i, "Mason-linux-x86_64.rpm"],
  ];
  const copies = [];
  for (const [pattern, name, platform] of assets) {
    const matches = files.filter(file => pattern.test(file));
    if (matches.length > 1) throw new Error(`Ambiguous artifact: ${name}`);
    if (!matches.length) {
      if (platform) throw new Error(`Missing updater artifact: ${name}`);
      continue;
    }
    const file = matches[0];
    copies.push([file, name]);
    if (platform) {
      const signature = readFileSync(`${file}.sig`, "utf8").trim();
      if (!signature) throw new Error(`Empty signature: ${name}`);
      platforms[platform] = {
        signature,
        // Versioned URLs keep manifest and binary consistent during new releases.
        url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
      };
      copies.push([`${file}.sig`, `${name}.sig`]);
    }
  }
  const notesFile = join(projectRoot, "release-notes", `${tag}.md`);
  const manifest = {
    version,
    notes: existsSync(notesFile) ? readFileSync(notesFile, "utf8") : `Mason ${tag}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
  mkdirSync(outputPath, { recursive: true });
  for (const [from, name] of copies) copyFileSync(from, join(outputPath, name));
  writeFileSync(join(outputPath, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--check-version") checkVersion(args[1]);
  else if (args.length === 4) prepareRelease(args[0], args[1], args[2], args[3]);
  else throw new Error("Usage: prepare-release.mjs <artifacts> <output> <tag> <owner/repo>");
}
