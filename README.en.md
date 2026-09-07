<div align="center">

![Mason Banner](./docs/banner_optimized.jpg)

# <img src="./public/logo.svg" height="48" style="vertical-align:bottom;margin-bottom:-10px;" /> Mason

**From Gerber to 3D-printable stencil — generate PCB solder paste printing tools in one click**
*Gerber parsing · Parametric CAD · Real-time 3D preview · Zero cloud dependency*

[中文](README.md) · [📝 Changelog](https://github.com/NingZiXi/mason/releases) · [🐛 Report Issues](https://github.com/NingZiXi/mason/issues) · [👤 Author](https://github.com/NingZiXi)

[![CI](https://github.com/NingZiXi/mason/actions/workflows/ci.yml/badge.svg)](https://github.com/NingZiXi/mason/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-3E7D62.svg)](./LICENSE) [![Tauri 2](https://img.shields.io/badge/Tauri-2.x-24C8DB.svg)](https://tauri.app) [![Vue 3](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org) [![Rust](https://img.shields.io/badge/Rust-stable-DEA584.svg)](https://www.rust-lang.org) [![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB.svg)](https://www.python.org) [![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-3E7D62)](#getting-started)

### ⬇️ Download

[![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/NingZiXi/mason/releases/latest) [![macOS](https://img.shields.io/badge/macOS-222222?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/NingZiXi/mason/releases/latest) [![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)](https://github.com/NingZiXi/mason/releases/latest)

> Prebuilt installers are available for all three platforms. Get the latest from [Releases](https://github.com/NingZiXi/mason/releases/latest).

</div>

---

## 📌 Overview

**Mason** is a desktop application built with Tauri 2 + Python (build123d) that converts Gerber ZIP files exported from JLCPCB into 3D-printable solder paste printing tools. It offers two working modes covering different scenarios from prototyping to small-batch production:

- **Stencil Jig Mode** — Generates a three-piece set (base / tray / cover) that clamps a pre-made metal stencil for printing. Ideal for irregular PCBs and scenarios requiring even pressure.
- **PCB Stencil Mode** — Directly generates an all-in-one stencil with a built-in PCB pocket based on the Paste Mask layer. Works independently without a jig, perfect for rapid prototyping.

The core design goal is a minimal workflow of "drag in Gerber → export STL", with sensible defaults that produce usable results out of the box.

---

## ✨ Features

### Gerber Parsing
- Auto-detects board outline layers (`.GKO` / `Edge.Cuts` / `.GM1`) and paste mask layers (`.GTP` / `.GBP`)
- Self-developed RS-274X parser supporting layer transform commands: `%LM` mirror, `%LR` rotation, `%LS` scaling
- Supports G02/G03 arcs, multi-line D-codes, and irregular board outline extraction
- Pad parsing covers circle / rectangle / obround / rounded rectangle / polygon / region fill aperture types

### Stencil Jig Mode
- Parametric three-piece generation: base (B-side, with M3 hex nut countersink), PCB tray (with screw-free integrated positioning posts), cover (A-side)
- Screw layout: 4 corners always present + evenly spaced perimeter screws based on spacing, supporting M2/M2.5/M3 screw spec linkage
- Jig size auto-calculated from stencil size (20mm steps); base and cover reusable for same-size PCBs
- Full irregular PCB outline reproduction with adjustable pocket clearance

### PCB Stencil Mode
- All-in-one stencil: PCB outer frame + top PCB pocket (depth = PCB thickness) + thin stencil layer at pocket bottom
- Pad openings only penetrate the stencil layer, precisely aligned with board outline coordinates
- Pad squaring (obround → right-angle rectangle, matching stencil manufacturer process)
- Test point filtering (enabled by default, matching JLCPCB stencil behavior)
- Post-processing options: dense pin staggering, large-hole grid
- Outer frame shape switchable between "follow board shape" and "rectangle", with adjustable corner radius
- Trapezoidal pick-and-place notch for easy PCB removal from the pocket

### General
- Real-time 3D preview (three.js) with background preheating of multiple parts, sub-second switching
- Stencil rendering deeply optimized — 2400+ pads complete in ~3 seconds
- Project parameter save / load (JSON)
- Chinese / English bilingual UI
- STL / STEP dual-format export with auto-created timestamp directories

---

## 🛠️ Getting Started

### Prerequisites

| Tool | Version | Description |
| --- | --- | --- |
| Node.js | 20+ | Frontend build |
| Rust | 1.77+ | Tauri backend compilation |
| Python | 3.11+ | CAD geometry generation (dev mode) |

### Development Mode

```bash
# 1. Install Python dependencies
pip install -r python/requirements.txt

# 2. Install frontend dependencies and start
npm install
npm run tauri:dev
```

In development mode, the app auto-detects system Python (PATH / common install locations). If not detected or dependencies are missing, you can manually specify the path or use one-click install in the "Python Environment" card.

### Build & Release (Bundled Python Engine, Zero Configuration for End Users)

The release package embeds a complete Python + build123d/shapely/numpy runtime, so end users need to install nothing:

```bash
# 1. Build bundled Python runtime (~500MB)
npm run build:python-env

# 2. Package desktop app
npm run tauri:build
```

Installer artifacts are in `src-tauri/target/release/bundle/` (Windows: `.msi` / `.exe`).

> **Note**: `resources` must use array syntax `["resources/python-env"]`. Map syntax `{"resources/python-env/**/*": "python-env/"}` flattens the `site-packages` directory tree and breaks dependencies.

---

## 📖 Usage

### Stencil Jig Mode

1. Drag in a Gerber ZIP to auto-detect the board outline
2. Confirm basic parameters: PCB size / thickness, stencil size, etc.
3. (Optional) Adjust advanced parameters: screw spacing, tray thickness, pocket clearance, etc.
4. Switch between base / insert / cover parts in the 3D preview on the right
5. Click "Export", select a directory — a `mason_export_<timestamp>/` subfolder is auto-created and STL files are written into it

### PCB Stencil Mode

1. Switch to "PCB Stencil" mode
2. Drag in a Gerber ZIP (must contain `.GTP` / `.GBP` paste mask layer)
3. Select stencil layer thickness preset (Resin 0.15mm / Standard 0.2mm / FDM 0.3mm)
4. (Optional) Adjust pad shrink ratio, frame width, outer corner radius, pick-and-place notch, etc.
5. Preview the generated stencil model, confirm pad opening positions and count
6. Export STL for direct 3D printing, or send to a stencil manufacturer for cutting

---

## 🏗️ Architecture

Mason uses a hybrid architecture of **Tauri 2 (Rust) + Vue 3 + Python (build123d)**:

```
┌────────────────────┐   IPC    ┌─────────────┐   spawn   ┌──────────────────┐
│  Vue 3 Frontend    │ ───────▶ │  Rust Backend│ ────────▶ │ Python CAD Engine│
│  three.js 3D View  │          │  Params JSON │           │ build123d+Shapely│
│  Pinia State       │ ◀─────── │  STL bytes   │ ◀──────── │ jig_generator.py │
└────────────────────┘          └─────────────┘           └──────────────────┘
```

- Frontend sends parameters to Rust via Tauri IPC; Rust writes `input.json` and calls `python/jig_generator.py` to generate STL
- Python runs as a persistent process (stdin/stdout line JSON protocol) to avoid repeated startup overhead
- STL cached in frontend by parameter hash; switching parts does not recompute; background preheating on app startup
- Thousand-pad stencils use a fast STL path (numpy directly generates triangle faces + OCC planar meshing), achieving second-level rendering performance

### Key Files

| Path | Description |
| --- | --- |
| `python/jig_generator.py` | CAD geometry generation: `build_base` / `build_insert` / `build_cover` / `build_stencil` |
| `src/lib/gerber/parser.ts` | RS-274X board outline parser |
| `src/lib/gerber/pads.ts` | Paste mask pad geometry extraction |
| `src/stores/config.ts` | Pinia global config state |
| `src/components/ModelPreview.vue` | three.js 3D preview and STL cache |
| `src/components/StencilForm.vue` | Stencil mode parameter panel |
| `src/components/ConfigForm.vue` | Jig mode parameter panel |
| `src-tauri/src/commands.rs` | Tauri IPC commands |
| `src-tauri/src/scad.rs` | Python persistent process manager |

---

## 🧪 Testing

The project includes frontend unit tests and Python geometry verification tests:

```bash
# Frontend: Gerber parser unit tests
npm test

# Frontend type checking
npx vue-tsc --noEmit

# Rust compilation check
cd src-tauri && cargo check

# Python geometry end-to-end verification (build123d)
python python/tests/run_all.py
```

Geometry verification tests cover: screw layout consistency, three-part geometry and hole positions, irregular board outlines, stencil pad openings, notch depth and direction, B-side hex nut countersink, etc. — 11 test scripts in total.

CI runs all checks via GitHub Actions on every push / PR.

---

## 📁 Project Structure

```
mason/
├── .github/workflows/ci.yml          # CI: vitest + vue-tsc + cargo check + python tests
├── public/                           # Static assets (logo.svg)
├── scripts/build-python-env.ps1      # Bundled Python runtime build script
├── src/                              # Vue 3 frontend
│   ├── components/                   # Business components (ConfigForm / StencilForm / ModelPreview ...)
│   ├── composables/                  # useGerberOutline / useGerberStencil
│   ├── lib/gerber/                   # Self-developed Gerber parser + unit tests
│   ├── i18n/                         # Chinese / English i18n
│   └── stores/                       # Pinia state management
├── src-tauri/                        # Rust backend (Tauri)
│   └── src/{commands,scad,openscad_detect,error}.rs
├── python/
│   ├── jig_generator.py              # build123d CAD generation (base/insert/cover/stencil)
│   └── tests/                        # Geometry end-to-end tests
├── test_gerber/                      # Sample Gerber files
└── README.md
```

---

## ❓ FAQ

**Q: App shows "Python not detected" on startup?**
A: In development mode, the app probes PATH and standard install locations. If Python is in a custom path, manually specify `python.exe` in the "Python Environment" card — it must have `build123d`, `shapely`, and `numpy` installed. Release builds include a bundled engine, so this step is unnecessary.

**Q: Gerber ZIP parsing fails?**
A: Board outline detection relies on `.GKO` / `*Edge.Cuts*` / `.GM1` files; stencil mode also requires a `.GTP` or `.GBP` paste mask layer. If files use unusual naming, you can manually select in the import component.

**Q: Stencil pads don't align with PCB pads?**
A: Mason squares obround pads by default (matching stencil manufacturer process) and aligns to the PCB board outline center. If misalignment persists, check whether the Gerber coordinate system matches the outline layer.

**Q: Where are exported files?**
A: On export, a `mason_export_<timestamp>/` subfolder is created in the selected directory, and all generated STL files are placed inside to avoid mixing with existing files.

---

## 📄 License

[MIT](./LICENSE)

---

## 🙏 Acknowledgements

- [build123d](https://github.com/gumyr/build123d) — Python parametric CAD kernel
- [Tauri](https://tauri.app/) — Desktop app framework
- [Vue 3](https://vuejs.org/) / [Pinia](https://pinia.vuejs.org/) / [Element Plus](https://element-plus.org/) / [three.js](https://threejs.org/)
- [Shapely](https://github.com/shapely/shapely) — 2D geometry operations

---

<div align="center">

If you find this project helpful, please give it a ⭐ Star! Your support means a lot 🙏

[![Star History Chart](https://img.shields.io/github/stars/NingZiXi/mason?style=social)](https://github.com/NingZiXi/mason/stargazers)

</div>
