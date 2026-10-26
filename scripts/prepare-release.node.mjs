import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkVersion, prepareRelease } from "./prepare-release.mjs";

test("release version is synchronized", () => {
  assert.equal(checkVersion("v0.1.7"), "0.1.7");
  assert.throws(() => checkVersion("v0.1.8"), /does not match/);
});

test("updater manifest pairs the signed artifacts for all platforms", () => {
  const dir = mkdtempSync(join(tmpdir(), "mason-release-test-"));
  try {
    const input = join(dir, "artifacts");
    const output = join(dir, "release");
    mkdirSync(input);
    for (const [name, signature] of [
      ["Mason_0.1.7_x64-setup.exe.zip", "windows-signature"],
      ["Mason.app.tar.gz", "macos-signature"],
      ["Mason_0.1.7_amd64.AppImage.tar.gz", "linux-signature"],
    ]) {
      writeFileSync(join(input, name), "binary");
      writeFileSync(join(input, `${name}.sig`), signature);
    }

    const manifest = prepareRelease(input, output, "v0.1.7", "NingZiXi/mason");
    assert.deepEqual(Object.keys(manifest.platforms).sort(), ["darwin-aarch64", "linux-x86_64", "windows-x86_64"]);
    assert.equal(manifest.platforms["windows-x86_64"].signature, "windows-signature");
    assert.equal(manifest.platforms["darwin-aarch64"].url, "https://github.com/NingZiXi/mason/releases/download/v0.1.7/Mason-macos-aarch64.app.tar.gz");
    assert.equal(JSON.parse(readFileSync(join(output, "latest.json"), "utf8")).version, "0.1.7");
    assert.equal(readFileSync(join(output, "Mason-linux-x86_64.AppImage.tar.gz.sig"), "utf8"), "linux-signature");
    assert.throws(() => prepareRelease(input, input, "v0.1.7", "NingZiXi/mason"), /must not be inside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
