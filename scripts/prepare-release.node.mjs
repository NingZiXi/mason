import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkVersion, prepareRelease } from "./prepare-release.mjs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = `v${version}`;

test("release version is synchronized", () => {
  assert.equal(checkVersion(tag), version);
  assert.throws(() => checkVersion(`${tag}-mismatch`), /does not match/);
});

test("updater manifest pairs the signed artifacts for all platforms", () => {
  const dir = mkdtempSync(join(tmpdir(), "mason-release-test-"));
  try {
    const input = join(dir, "artifacts");
    const output = join(dir, "release");
    mkdirSync(input);
    for (const [name, signature] of [
      [`Mason_${version}_x64-setup.exe`, "windows-signature"],
      ["Mason.app.tar.gz", "macos-signature"],
      [`Mason_${version}_amd64.AppImage`, "linux-signature"],
    ]) {
      writeFileSync(join(input, name), "binary");
      writeFileSync(join(input, `${name}.sig`), signature);
    }

    const manifest = prepareRelease(input, output, tag, "NingZiXi/mason");
    assert.deepEqual(Object.keys(manifest.platforms).sort(), ["darwin-aarch64", "linux-x86_64", "windows-x86_64"]);
    assert.equal(manifest.platforms["windows-x86_64"].signature, "windows-signature");
    assert.equal(manifest.platforms["darwin-aarch64"].url, `https://github.com/NingZiXi/mason/releases/download/${tag}/Mason-macos-aarch64.app.tar.gz`);
    assert.equal(JSON.parse(readFileSync(join(output, "latest.json"), "utf8")).version, version);
    assert.equal(readFileSync(join(output, "Mason-linux-x86_64.AppImage.sig"), "utf8"), "linux-signature");
    assert.throws(() => prepareRelease(input, input, tag, "NingZiXi/mason"), /must not be inside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
