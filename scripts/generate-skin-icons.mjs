import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "public/logo.svg"), "utf8");
const output = join(root, "src-tauri/icons");

// Tauri's generated PNGs are non-interlaced RGBA8. Decode with Node's built-ins
// so regenerating native icons requires no extra image package or Python setup.
function decodeRgba(png) {
  const parts = [];
  let width, height;
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "Expected 8-bit PNG");
      assert.equal(data[9], 6, "Expected RGBA PNG");
      assert.equal(data[12], 0, "Expected non-interlaced PNG");
    }
    if (type === "IDAT") parts.push(data);
    offset += size + 12;
  }
  assert.equal(width, 128);
  assert.equal(height, 128);
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(parts));
  assert.equal(raw.length, height * (stride + 1));
  const rgba = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4, "Unsupported PNG filter");
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= 4 ? rgba[i - 4] : 0;
      const up = y ? rgba[i - stride] : 0;
      const corner = y && x >= 4 ? rgba[i - stride - 4] : 0;
      const prediction = filter === 1 ? left : filter === 2 ? up : filter === 3
        ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, corner) : 0;
      rgba[i] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return rgba;
}

for (const [skin, primary, accent] of [
  ["classic", "#3E7D62", "#E07A3C"],
  ["sakura", "#D85C8A", "#4169D8"],
]) {
  const temporary = join(root, "test_out/generated-skin-icons", skin);
  await mkdir(temporary, { recursive: true });
  const svg = join(temporary, "logo.svg");
  await writeFile(svg, source.replace('<svg ', '<svg width="1024" height="1024" ')
    .replaceAll("#3E7D62", primary).replaceAll("#E07A3C", accent));
  const result = spawnSync(process.execPath, [
    join(root, "node_modules/@tauri-apps/cli/tauri.js"), "icon", svg, "--output", temporary,
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || result.stdout);
  await copyFile(join(temporary, "icon.ico"), join(output, `skin-${skin}.ico`));
  const png = await readFile(join(temporary, "128x128.png"));
  await writeFile(join(output, `skin-${skin}.png`), png);
  await writeFile(join(output, `skin-${skin}.rgba`), decodeRgba(png));
  console.log(`Generated ${skin} ICO, PNG and 128×128 RGBA`);
}
