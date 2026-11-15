# WuWaViewer Developer & Modding Documentation

WuWaViewer is a local web-based 3D asset browser, shader renderer, animation/cutscene player, and physics previewer for *Wuthering Waves* (UE4/UE5 packages via CUE4Parse).

This `docs/` folder documents the exact codebase architecture, asset loading pipeline, Toon/V2/wet/emissive shaders, and Blender modding/export workflows so both **local coding agents** and **modders** can work safely without rediscovering engine quirks.

---

## Documentation Index

| Document | Audience | Contents |
|---|---|---|
| [FILE_LOADING_PIPELINE.md](./FILE_LOADING_PIPELINE.md) | Agents / Engineers | VFS mounting (`Paks`, `HD`, `Saved/Resources`), `GameAssetService` indexing, Blueprint part/form resolution, GLB/PNG extraction & disk caching, Animations, KawaiiPhysics, Cutscenes |
| [SHADERS_AND_TEXTURES.md](./SHADERS_AND_TEXTURES.md) | Agents / Shader Devs / Modders | `ClassifyShaderType`, texture slot lookup & filter rules, `_N` channel packing, **`CharV1` vs `CharV2` opacity (`MainTex.a` vs `TypeMask.r`)**, `RegionIDTex`, Wet/Wet-Alpha, Eye/Emissive, `_OL` outline |
| [BLENDER_MODDING_WORKFLOW.md](./BLENDER_MODDING_WORKFLOW.md) | Modders / Technical Artists | Extracting base GLBs & PNGs, UE↔glTF coordinate conversion (`CoordConvert`), mesh/material/UV/`COLOR_0`/morph preservation, armature & `KawaiiPhysics` rules, `_D`/`_N`/`_FTM`/`_RGID` authoring pitfalls |

---

## Workspace Layout

```text
WuWaViewer/
├── .env.example                   # Template for WUWA_GAME_DIR / WUWA_KEYS_PATH / WUWA_CACHE_DIR / port env vars
├── keys.example.json              # Example AES key file schema (mainKey + dynamicKeys)
├── start-viewer.ps1               # Loads .env and starts backend (:5180) and Vite frontend (:5173)
├── wuwa-keys/keys.json            # AES mainKey + dynamicKeys (gitignored external clone)
├── WuWaViewer.Net9/               # Local CUE4Parse (.NET 9) & CUE4Parse-Conversion projects
├── WuWaViewer.Server/             # ASP.NET Core (.NET 9) Web API & asset extraction backend
│   ├── appsettings.json           # Default non-sensitive config template
│   ├── appsettings.Local.example.json # Template for gitignored local path overrides
│   ├── Program.cs                 # .env + config loader, Minimal API endpoints, WUWA_API_URL host
│   ├── Models/ViewerDtos.cs       # Shared C# record DTOs matching frontend/src/types.ts
│   └── Services/                  # GameAssetService, ModelService, AnimationService, PhysicsService, RbfService, CutsceneService, CoordConvert
├── scripts/
│   └── blender/
│       └── wuwa_rbf_rig.py        # Blender 4.2+/5.2 LTS addon & CLI for USkeleton RBFDrivers & PoseDrivers
├── frontend/                      # React 18 + Three.js 0.172 + TypeScript + Vite 6
│   ├── vite.config.ts             # Dev server on VITE_PORT (:5173), proxies /api -> VITE_API_TARGET (:5180)
│   └── src/
│       ├── types.ts               # TypeScript DTO mirrors & shader/physics runtime types
│       ├── shaders/wuwaShaders.ts # Toon/PBR/Clay/Wireframe + CharV1/V2 + Wet/Alpha/Eye/Outline shaders
│       ├── animation/AnimationEngine.ts
│       ├── physics/KawaiiPhysicsSolver.ts
│       ├── components/WuWaViewport.tsx
│       └── App.tsx
├── CUE4Parse/                     # Reference CUE4Parse codebase (Apache-2.0) — DO NOT MODIFY (git submodule)
├── ref/                           # External read-only reference repos — DO NOT MODIFY (gitignored)
│   └── ue5-wuwa-shader/           # Sparse clone (README.md + Plugins/WuwaToon/): .ush shaders & Specs/ JSON
└── FModel/                        # Optional local reference clone if present — DO NOT MODIFY (gitignored)
```

---

## Configuration & Running Locally

### Configuration (`.env` / `WuWaViewer.Server/appsettings.Local.json`)
Configuration resolves in order of increasing precedence: `appsettings.json` → `appsettings.Local.json` (gitignored) → `.env` / environment variables (`WUWA_GAME_DIR`, `WUWA_KEYS_PATH`, `WUWA_CACHE_DIR`) → CLI args:
- **`GameDir` (`WUWA_GAME_DIR`)**: Path to your local *Wuthering Waves* installation directory (contains `Client/Content/Paks`, etc.). **Required** (intentionally blank in tracked `appsettings.json`).
- **`KeysPath` (`WUWA_KEYS_PATH`)**: Path to AES keys JSON (`wuwa-keys/keys.json`, containing `mainKey` and `dynamicKeys`).
- **`CacheDir` (`WUWA_CACHE_DIR`)**: Disk cache root (`cache` by default) storing extracted `manifest/`, `glb/`, `tex/`, `anim/`, and `rbf/` files.
- **`WUWA_API_URL` / `VITE_API_TARGET` / `VITE_PORT`**: Optional backend/frontend bind & proxy URLs (default `:5180` / `:5173`).

### Launch Commands
One-shot launcher from repo root:
```powershell
.\start-viewer.ps1
```
Or run backend and frontend separately:
```powershell
# Terminal 1 — Backend (http://localhost:5180)
cd WuWaViewer.Server
dotnet run --no-build

# Terminal 2 — Frontend (http://localhost:5173, /api proxied to :5180)
cd frontend
npm run dev -- --port 5173 --strictPort
```

### Build & Verification Commands
```powershell
# Backend build (.NET 9, links CUE4Parse.Net9 + native Oodle/CUE4Parse-Natives DLLs)
dotnet build WuWaViewer.Server/WuWaViewer.Server.csproj

# Frontend TypeScript check & Vite production bundle
cd frontend
npx tsc --noEmit
npm run build
```

---

## HTTP API Endpoints (`WuWaViewer.Server/Program.cs`)

| Route | Query / Param | Returns |
|---|---|---|
| `GET /api/health` | — | VFS readiness, counts (`characters`, `weapons`, `cutscenes`) |
| `GET /api/characters` | — | Indexed playable/role character list (`CharacterSummaryDto[]`) |
| `GET /api/characters/{*id}` | e.g. `FemaleMS/Daniya` | Full `CharacterSummaryDto` with variants, forms, weapons |
| `GET /api/weapons` | `?q=&limit=100` | Weapon & prop `SkeletalMesh`/`StaticMesh` catalog |
| `GET /api/model/manifest` | `?path=` | `ModelManifestDto` (LOD0 sections, materials, switches, textures, sockets, morphs) |
| `GET /api/model/form-materials` | `?path=` | `ModelFormMaterialsDto` (`Switch02`, `02`, `Seq02`, `Damage`, `BlendWater` presets) |
| `GET /api/model/glb` | `?path=` | Cached or freshly exported binary `.glb` (`EMeshFormat.Gltf2`, no embedded materials) |
| `GET /api/texture` | `?path=` | Cached or freshly exported lossless `.png` texture |
| `GET /api/animations` | `?characterId=&includeShared=true` | Character + matching `BaseAnim` + `SequenceAnim` list (with `Rib_*` pairing) |
| `GET /api/animation` | `?path=&ribbonPath=` | `AnimationPayloadDto` (tracks in glTF space + `FloatCurves` morph curves + `RibbonLayer`) |
| `GET /api/physics` | `?characterId=&abp=` | `PhysicsConfigDto` extracted from `AnimNode_KawaiiPhysicsGroup` in `ABP_*` / `*_PC` |
| `GET /api/rig/rbf` | `?meshPath=&skeletonPath=&characterId=&abp=` | `RigRbfConfigDto` (`USkeleton` `RBFDrivers` + `Precomputations` LUTs & `PoseDriver` / `UPoseAsset` deltas for Blender rigging) |
| `GET /api/cutscenes` | `?character=&category=&q=&limit=120` | `CutsceneSummaryDto[]` |
| `GET /api/cutscene` | `?path=` | LevelSequence tracks (skeletal anims, 3D actor/camera transforms, focal length FOV) |

---

## Agent & Engineering Guardrails

1. **Never edit anything under `CUE4Parse/`, `ref/`, or `FModel/`**: External upstream submodules/references (read-only).
2. **How to Use `ref/ue5-wuwa-shader/` Safely**:
   - Read [SHADERS_AND_TEXTURES.md](./SHADERS_AND_TEXTURES.md) first; consult `ref/ue5-wuwa-shader/Plugins/WuwaToon/Shaders/Private/` only when you need exact UE texture channel packing, `StaticSwitch` logic, or math intent.
   - `ref/ue5-wuwa-shader` is a sparse clone (`README.md` + `Plugins/`; root `Content/*.uasset` binaries are omitted). Do **not** read entire `.ush` or `Specs/*.json` files (`WuwaToonBasePass_V2Body.ush` is >9,000 lines and specs are >1,600 lines) — `grep`/`rg` for the material/switch/parameter name first, then read only the targeted block.
   - `.ush` files contain decompiled DXBC bit patterns (`asfloat(0x...)`) and UE5 `GBufferA..D` outputs. Never copy HLSL verbatim into `frontend/src/shaders/wuwaShaders.ts`; translate the channel semantics and conditions into Three.js WebGL/GLSL.
3. **Respect the UV & Axis Contract**:
   - Backend converts all positions (`* 0.01`), rotations, vectors, scales, and animations via `CoordConvert` (`WuWaViewer.Server/Services/CoordConvert.cs`) to match `CUE4Parse-Conversion` glTF Y-up meters (`[X, Z, Y]`, quat `[q.X, q.Z, q.Y, -q.W]`).
   - Frontend loads all PNGs with `tex.flipY = false` (glTF top-left origin).
4. **Material Shaders Follow Two Distinct Generations (`CharV1` vs `CharV2`)**:
   - Never assume `MainTex.a` is opacity across all characters. On **`CharV2`** (`M_CharV2_Com`, `MI_CharV2_Body` and children such as `Daniya`, `Aimisi`, `Mone`), **`MainTex.a` encodes Shadow/Specular/Breath (`0` on neck/skin pixels)** while **`TypeMask.r` (`_FTM`) encodes opacity**.
5. **Disk Cache Awareness**:
   - `GameAssetService.GetCacheFilePath` caches manifests, GLBs, PNGs, and parsed animations under `CacheDir`. If you alter C# DTO extraction or GLB export options (`ModelService`, `AnimationService`), clear stale files in `<CacheDir>/{manifest,glb,anim}` before testing.
6. **No UI One-Click GLB Export Button**:
   - WuWaViewer does not expose a browser "Download GLB" button; download extracted `.glb` and `.png` files directly from `/api/model/glb?path=...` and `/api/texture?path=...`, or read them from `<CacheDir>/glb/` and `<CacheDir>/tex/`.

---

## Task-to-File Routing Table (Quick Lookup for Agents)

| Task / Symptom | Primary File(s) & Key Symbol(s) |
|---|---|
| Missing character, variant, or modular form (`_Up2`/`_Up3`/`_Hair2`) | `WuWaViewer.Server/Services/GameAssetService.cs` → `BuildIndices`, `BuildVariants`, `BuildVariantForms`, `PopulateLinkedForms` |
| Missing/offset Blueprint extra part or weapon attachment | `WuWaViewer.Server/Services/ModelService.cs` → `ResolveBlueprintParts`, `CoordConvert.cs`; `frontend/src/components/WuWaViewport.tsx` |
| Wrong `ShaderType`, missing alternate skin/form material preset (`Switch02`/`02`), missing wet textures | `WuWaViewer.Server/Services/ModelService.cs` → `ClassifyShaderType`, `ResolveFormMaterialsAsync`, `AttachWetOverlayMetadata` |
| Section/material mismatch on loaded GLB (`materialName`, `_OL`/`_FS`/`_HETA`) | `frontend/src/components/WuWaViewport.tsx` → `matchMeshSections`, `applyMaterialsToEntries` |
| Transparent holes, wrong alpha (`CharV1` vs `CharV2`), wet/wet-alpha, eye glow, outline shell | `frontend/src/shaders/wuwaShaders.ts` → `resolveWuWaAlphaAndWetConfig`, `resolveWuWaEmissiveConfig`, `wuWaEvaluateAlphaGlsl`, `wuWaWetSurfaceGlsl`, `createWuWaMaterialForSection` (+ `customProgramCacheKey`) |
| Verifying unknown UE texture channel packing or `StaticSwitch` combinations | [SHADERS_AND_TEXTURES.md](./SHADERS_AND_TEXTURES.md), then grep `ref/ue5-wuwa-shader/Plugins/WuwaToon/Shaders/Private/` (`.ush`, `Specs/`, `Specs/registry/`) — read-only |
| Bone animation glitch, `Rib_*` layering, facial morph curves | `WuWaViewer.Server/Services/AnimationService.cs`; `frontend/src/animation/AnimationEngine.ts` → `captureRestPose`, `applyTrackList`, `evalFloatCurve` |
| Hair/skirt physics jitter or missing bone chains | `WuWaViewer.Server/Services/PhysicsService.cs`; `frontend/src/physics/KawaiiPhysicsSolver.ts` |
| Blender corrective shape keys (`L_*`/`R_*`) & PoseDriver helper bones | `WuWaViewer.Server/Services/RbfService.cs` (`GET /api/rig/rbf`); `scripts/blender/wuwa_rbf_rig.py`; [BLENDER_MODDING_WORKFLOW.md §3.4](./BLENDER_MODDING_WORKFLOW.md#34-shape-keys-morph-targets--corrective-pose-drivers) |
| LevelSequence cutscene camera/actor transform | `WuWaViewer.Server/Services/CutsceneService.cs`; `frontend/src/animation/AnimationEngine.ts` → `applyCutsceneActorTransform` |
| Shared C# ↔ TypeScript API schema changes | Must match in **both** `WuWaViewer.Server/Models/ViewerDtos.cs` (PascalCase C#) and `frontend/src/types.ts` (camelCase JSON) |
