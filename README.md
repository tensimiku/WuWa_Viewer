# WuWaViewer

Local web-based 3D asset viewer, shader renderer, animation/cutscene player, and KawaiiPhysics previewer for *Wuthering Waves* (UE4/UE5 assets via CUE4Parse + Three.js).

See [docs/README.md](docs/README.md) for full architecture, API endpoints, shader specifications, and modding workflows.

## Prerequisites

- [.NET 9 SDK](https://dotnet.microsoft.com/download/dotnet/9.0)
- [Node.js](https://nodejs.org/) (v20+ recommended) + `npm`
- Local *Wuthering Waves* game installation (`Client/Content/Paks`)
- External upstream repositories:
  - [`CUE4Parse`](https://github.com/FabianFG/CUE4Parse) (`Apache-2.0`, tracked as a Git submodule at `CUE4Parse/`)
  - [`wuwa-keys`](https://github.com/yarik0chka/wuwa-keys) (external clone, ignored in `.gitignore` — or supply your own `keys.json`, see [`keys.example.json`](keys.example.json))

## Quick Setup

1. **Clone this repository with submodules** (`CUE4Parse` + its `acl` C++ submodule), then clone `wuwa-keys` alongside it:

   ```bash
   git clone --recurse-submodules https://github.com/tensimiku/WuWa_Viewer.git
   cd WuWa_Viewer
   git clone https://github.com/yarik0chka/wuwa-keys wuwa-keys
   ```

   *(If you already cloned without `--recurse-submodules`, run `git submodule update --init --recursive`.)*

   *(Optional UE5 shader reference for contributors — kept gitignored under `ref/`:*
   ```bash
   git clone --filter=blob:none --sparse https://github.com/GachaWhisperer/ue5-wuwa-shader ref/ue5-wuwa-shader
   git -C ref/ue5-wuwa-shader sparse-checkout set /README.md /Plugins/**
   ```
   *)*

2. **Native libraries (`WuWaViewer.Server/native/`)**:

   Binary `.dll` files are not committed to this repository (see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)).
   - **Oodle (`oodle-data-shared.dll`)**: Automatically downloaded at runtime by `OodleHelper.InitializeAsync(...)` into the server output folder if missing (or place it manually in `WuWaViewer.Server/native/`).
   - **ACL Animations (`CUE4Parse-Natives.dll`)**: Optional for model/texture viewing, required for ACL-compressed animations. Build it with CMake from `CUE4Parse/CUE4Parse-Natives` (`.vscode/settings.json` is preconfigured) and copy the output DLL to `WuWaViewer.Server/native/CUE4Parse-Natives.dll` (or next to the server executable).

3. **Install frontend dependencies**:

   ```bash
   cd frontend
   npm install
   cd ..
   ```

4. **Configure your local paths** (choose either option — both are gitignored):

   - **Option A — `.env` at repository root**:
     Copy [`.env.example`](.env.example) to `.env` and set `WUWA_GAME_DIR` (and optionally `WUWA_KEYS_PATH`, `WUWA_CACHE_DIR`, `WUWA_API_URL`, `VITE_PORT`).
   - **Option B — `appsettings.Local.json` inside `WuWaViewer.Server/`**:
     Copy [`WuWaViewer.Server/appsettings.Local.example.json`](WuWaViewer.Server/appsettings.Local.example.json) to `WuWaViewer.Server/appsettings.Local.json` and fill in `"GameDir"`.

5. **Build & Run**:

   ```powershell
   # Windows one-command launcher (UI on http://localhost:5173, API on http://localhost:5180)
   .\start-viewer.ps1

   # Or pass paths explicitly:
   .\start-viewer.ps1 -GameDir "D:\Games\Wuthering Waves Game"
   ```

   Or manually in two terminals:

   ```bash
   # Terminal 1 — Backend
   dotnet build WuWaViewer.Server/WuWaViewer.Server.csproj
   dotnet run --project WuWaViewer.Server/WuWaViewer.Server.csproj

   # Terminal 2 — Frontend
   cd frontend
   npm run dev -- --port 5173 --strictPort
   ```

## Environment Variables

| Variable | Config Mapping | Default | Purpose |
|---|---|---|---|
| `WUWA_GAME_DIR` | `WuWaViewer:GameDir` | *(required)* | Game root folder containing `Client/Content/Paks` |
| `WUWA_KEYS_PATH` | `WuWaViewer:KeysPath` | `wuwa-keys/keys.json` | AES key file (`mainKey` + `dynamicKeys`) |
| `WUWA_CACHE_DIR` | `WuWaViewer:CacheDir` | `cache` | Disk cache directory for extracted GLB/PNG/JSON assets |
| `WUWA_API_URL` | `--urls` / bind URL | `http://localhost:5180` | Backend HTTP URL (`ASPNETCORE_URLS` takes precedence) |
| `VITE_API_TARGET` | Vite `/api` proxy | `http://localhost:5180` | Backend target used by Vite dev server |
| `VITE_PORT` | Vite dev port | `5173` | Frontend dev server port |

*(ASP.NET Core double-underscore variables like `WuWaViewer__GameDir` are also supported; override `CUE4Parse` checkout path during MSBuild via `-p:Cue4ParseRoot=...`.)*

## Documentation

- [docs/README.md](docs/README.md) — Workspace map, API endpoints & development guardrails
- [docs/FILE_LOADING_PIPELINE.md](docs/FILE_LOADING_PIPELINE.md) — VFS mounting, GLB export, coordinate conversion & physics
- [docs/SHADERS_AND_TEXTURES.md](docs/SHADERS_AND_TEXTURES.md) — Three.js toon/PBR shader pipelines & texture channel layout
- [docs/BLENDER_MODDING_WORKFLOW.md](docs/BLENDER_MODDING_WORKFLOW.md) — Extracting assets & preparing models for Blender modding

## License & Third-Party Notices

- `WuWaViewer` original code & documentation: **MIT License** ([`LICENSE`](LICENSE)).
- `CUE4Parse` submodule and `WuWaViewer.Net9` compatibility wrappers: **Apache License 2.0** — see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and `CUE4Parse/NOTICE`.
