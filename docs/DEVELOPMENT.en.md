# Mason development guide

[Back to README](../README.en.md) · [简体中文](./DEVELOPMENT.md)

## Run locally

Install Node.js 20+, Rust stable, Python 3.12 (matching the current CI), and the [Tauri prerequisites for your platform](https://v2.tauri.app/start/prerequisites/). Run the commands below from the repository root.

```sh
npm ci
python -m pip install -r python/requirements.txt
npm run tauri:dev
```

`tauri:dev` starts the desktop app with hot reload; `npm run dev` starts only the web development server. The development app detects system Python, or you can select an interpreter with the required dependencies in Python Environment.

## Package the app

Build the bundled Python runtime before packaging the desktop app.

Windows:

```sh
npm run build:python-env
npm run tauri:build
```

macOS / Linux:

```sh
bash scripts/build-python-env.sh
npm run tauri:build
```

Installers are written to `src-tauri/target/release/bundle/`. Runtime build scripts install dependencies from `python/requirements.txt`; rebuild the runtime after changing dependencies.

Maintain the CAD engine in `python/jig_generator.py` only. The Rust build synchronizes it into bundled resources. Keep the Python runtime resource in `tauri.conf.json` as a directory entry in the resources array, preserving the `site-packages` directory structure.

## Checks & tests

```sh
# Frontend unit tests, type checking, and production build
npm test -- --run
npm run build

# Rust backend regression tests
cargo test --manifest-path src-tauri/Cargo.toml --lib

# Python geometry checks and regression tests
python -m pip install pytest
python python/tests/run_all.py
python -m pytest python/test_jig_generator.py -q

# Release manifest and engine resource synchronization
npm run test:release
python -m unittest discover -s scripts -p test_build_sync.py
```

The [CI workflow](../.github/workflows/ci.yml) defines the continuous integration checks.

## Code layout

The frontend handles Gerber parsing, parameters, and previews, and calls Rust through Tauri IPC. Rust schedules persistent Python workers to generate models. STL previews are cached by parameters; STEP files are exported by the modeling engine.

| Location | Responsibility |
| --- | --- |
| `src/lib/gerber/` | Outline, pad, and panel parsing |
| `src/stores/` | Parameters, presets, UI, and work state |
| `src/components/` | Parameter forms, 2D inspection, and 3D preview |
| `src/i18n/` | Chinese, English, Japanese, and Korean messages, with system-language matching |
| `src-tauri/src/` | IPC, Python detection, and task scheduling |
| `python/` | CAD modeling and geometry tests |
| `docs/` | Static website; see the [website story notes](./src/README.md) for maintenance |

## Release

See the [Release workflow](../.github/workflows/release.yml). Pushing a `v*` tag triggers builds and publication. Official update packages require the signing key configured for the workflow.

Before releasing, synchronize the app version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`, and write notes in `release-notes/v<version>.md`. The workflow produces signed update artifacts and `latest.json` for the in-app updater.
