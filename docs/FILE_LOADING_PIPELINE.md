# File Loading & Asset Extraction Pipeline

This document traces the end-to-end pipeline from encrypted Unreal Engine pak files on disk to interactive Three.js meshes, skeletal animations, KawaiiPhysics chains, and LevelSequence cutscenes in WuWaViewer.

---

## 1. Virtual File System (VFS) Initialization & AES Decryption

Implemented in `WuWaViewer.Server/Services/GameAssetService.cs`:

1. **Oodle & Compression Setup**: Initializes `OodleHelper` (backed by native `oodle-data-shared.dll` — auto-downloaded if missing — and optional `CUE4Parse-Natives.dll` for ACL animations) and targets `EGame.GAME_WutheringWaves`.
2. **Mounted Directories** (under `ViewerOptions.GameDir`):
   - `Client/Content/Paks` (base paks/utoc/ucas)
   - `HD` (high-definition pak/resource overrides if present)
   - `Saved/Resources/*` (downloaded patch/hotfix resources), **explicitly excluding**:
     - `Video`, `RoleVoice*`, `Diff`, `Mount`, `ResManifest`, `Lang_*`
3. **AES Key Loading**:
   - Reads `ViewerOptions.KeysPath` (default `wuwa-keys/keys.json`, resolved across repo root / server directory; override via `WUWA_KEYS_PATH`, `.env`, or `appsettings.Local.json`).
   - Expects JSON shape `{ "mainKey": "...", "dynamicKeys": [{ "guid": "...", "key": "..." }] }`.
4. **Path Normalization**:
   - `NormalizePackagePath(string path)` strips `.uasset` / `.uexp` / object sub-names (`Foo.Foo`), normalizes `/` separators, and resolves `AllUAssets` keys (`Client/Content/Aki/...`).

---

## 2. Asset Discovery & Form Resolution

### 2.1 Character, Weapon & Cutscene Indexing (`GameAssetService.BuildIndices`)
- **Characters**: Scans `Client/Content/Aki/Character/Role/<BodyType>/<CharDir>/...`:
  - Skips ignored shared folders: `CommonTexture`, `CommonData`, `Common`, `CapsuleAO`, `Role_Lowest`, `BaseAnim*`, `BasePhysics`.
  - Strips trailing `_Lifu` suffix from `<CharDir>` so variants group under the same `<BodyType>/<CharName>` character ID (e.g. `FemaleMS/Daniya`, `FemaleXL/Kanteleila`).
- **Weapons & Props**: Scans `Client/Content/Aki/Character/Weapon/<Category>/<WeaponName>/.../Model/`, ignoring `_Low`, `_Simple`, textures/materials (`T_`, `MI_`, `M_`, `P_`, `DA_`), skeletons, physics, and shadow helpers.
- **Cutscenes**: Scans `Client/Content/Aki/Sequence/`, excluding animation/blueprint/audio/VFX/UI helper directories (`SequenceAnim`, `Anim`, `Ani`, `DA_Face`, `Generated`, `Mat`, `BP`, `SplitScreen`, `PostProcess`, `Audio`) and helper asset prefixes (`VO_`, `DA_`, `BP_`, `Generated_`, `Camera_Shake`, `T_`, `MI_`, `M_`, `SM_`, `SK_`, `*_C`). Categorizes into `DrawCard`, `MainStory`, `RoleQuest`, `Combat`, `Other`.

### 2.2 Modular Variant Forms & Cross-Character Linked Forms
- **Cross-Character Forms (`PopulateLinkedForms`)**: Links separate character IDs that represent transformation states:
  - `FemaleMS/Katixiya` (`BaseForm`) ↔ `FemaleZ/Fuludelisi` (`LiberationForm`)
  - `FemaleM/Aimisi` (`BaseForm`) ↔ `FemaleZ2/AimisiGD` (`MechForm`)
  - `FemaleXL/Xinyuehu` (`BaseForm`) ↔ `FemaleXL/XinyuehuShen` (`AwakenedForm`)
- **Within-Variant Modular Forms (`BuildVariantForms`)**: Detects suffix meshes inside the variant's `Model/` folder and generates UI `CharacterFormDto` toggles:
  - `_Up1` + `_Up3` → `"변신 / 해방 폼 (_Up3)"` (`form_up3`, e.g., Zanni)
  - `_1` + `_3` → `"변신 / 공명 해방 (_3)"` (`form_part3`, e.g., Kakaluo)
  - `_Body`/`_body` + `_Up2`/`_up1` → `"변신 폼 (<suffix>)"` (`form_body_up2`, e.g., Daniya `_Body` + `_Up2`, Luosela, Rebecca)
  - `_Body` + `_Hair2` / `_Hair3` → `form_hair2` / `form_hair3`
  - `_Body` + `_Tail2` → `tail2` swap

### 2.3 Blueprint Part Discovery (`ModelService.ResolveBlueprintParts`)
- Locates `BP_*` Blueprints associated with the variant and walks the `SuperStruct` inheritance chain as well as `SimpleConstructionScript.AllNodes`.
- Extracts each `SCS_Node`'s component template (`USkeletalMeshComponent` / `UStaticMeshComponent`), its `AttachParent`, socket name (`AttachToName`), and relative local transform converted via `CoordConvert`.
- `WuWaViewport.tsx` uses these part definitions to mount extra meshes (wings, horns, halos, weapons, tails) onto exact bone sockets on the primary rig—or as `CharacterMesh`-relative attachments—when toggled or required by a form.

### 2.4 Alternate Form Material Presets (`ModelService.ResolveFormMaterialsAsync` + `/api/model/form-materials`)
Scans the variant's `/Model/` and `/Seq/` directories (skipping `_Simple`, `_Low`, `_OL`, `_FS`, `_Shadow`) for alternate material instances (`MI_*`) and alternate textures (`T_*`) tagged with:
- `Switch03`, `Switch02`, `Switch`, `Change`, `Seq04`, `Seq02`, `Damage`, `BlendWater`, and numeric suffixes `02` / `03`.
- Matching alternate `T_` files clone the base `MaterialSlotDto` and swap only the matching channel (`_D`, `_N`, `_ID`, `_HM`, `_M`, `_E`, `_ORM`, `_S`) while keeping the remaining maps intact.
- Preserves full `MI_` overrides when an explicit alternate `MI_` exists (e.g., Daniya's `02` skin/costume preset).

---

## 3. Model Manifest, GLB Export & Disk Caching (`ModelService`)

### 3.1 Export Options
- **Meshes (`MeshExportOpts`)**:
  - `EMeshFormat.Gltf2` (binary `.glb`)
  - `EMeshQuality.Highest` (LOD0 geometry preserved)
  - `exportMaterials: false` (WuWaViewer builds its own WebGL/GLSL shaders in `wuwaShaders.ts` from `ModelManifestDto` instead of relying on glTF PBR defaults)
  - `exportMorphTargets: true` (facial/shape keys preserved in `.glb`)
  - `includeDisabledMeshSections: false`
- **Textures (`TexExportOpts`)**:
  - `ETextureFormat.Png`, `textureQuality: 100` (lossless PNG decoding from game UTexture2D).

### 3.2 Manifest Structure (`ModelManifestDto`)
*(Note: C# DTO records in `ViewerDtos.cs` use PascalCase properties; ASP.NET Core JSON responses and `frontend/src/types.ts` use camelCase keys.)*

For each `USkeletalMesh` (or `UStaticMesh`), `ModelService` builds:
1. **Material Slots (`Materials` / JSON `materials`)**: Walks up to `guard < 16` levels of `UMaterialInterface.Parent` to aggregate inherited scalar parameters (`Scalars` / `scalars`), vector/color parameters (`Vectors` / `vectors`), static switch booleans (`Switches` / `switches`), `BlendMode` (`blendMode`), `TwoSided` (`twoSided`), and texture asset paths (`Textures` / `textures`), plus `ClassifyShaderType(...)` (`ShaderType` / `shaderType`).
2. **Wet Metadata Attachment (`AttachWetOverlayMetadata`)**: For every material `miName`, probes the VFS for matching wet textures/materials under `/Wet/{miName}_Darken`, `{miName}_Reflect`, and `/BlendWater/{miName}_BlendWater` and injects `HasBlendWaterMI`, `HasWetDarkenTex`, `HasWetReflectTex`, etc. into slot switches/textures.
3. **LOD0 Section Mapping & Overlays (`Sections` / JSON `sections`)**: Frontend `matchMeshSections` (`WuWaViewport.tsx`) maps `.glb` mesh primitives to LOD0 `MeshSectionDto` entries first by case-insensitive material name (`materialName` / `slot.name`), falling back to positional index when enabled section counts match. Overlay materials are linked by `outlineMaterialIndex`, `faceShadowMaterialIndex`, and `hetaMaterialIndex`:
   - `_OL` / `OL` → `Outline` inverted-hull overlay (`outlineMaterialIndex`)
   - `_FS` / `_Shadow` → `FaceShadow` SDF shadow overlay (`faceShadowMaterialIndex`)
   - `_HETA` / `_HET` → tear/eye highlight overlay (`hetaMaterialIndex`)
4. **Sockets & Morph Targets**: Extracts socket names, parent bones, and relative Y-up meter transforms from both the mesh and its `USkeleton` via `CoordConvert.SwapPos` / `SwapRotatorToQuat` / `SwapScale`, plus LOD0 `MorphTargets` (`morphTargets`) string names.

### 3.3 Disk Cache Layout (`GameAssetService.GetCacheFilePath`)
All extracted data is cached on disk under `<CacheDir>/<category>/`:
- `manifest/*.json` — `ModelManifestDto`
- `glb/*.glb` — Binary glTF mesh (`exportMaterials: false`)
- `tex/*.png` — Decoded lossless PNG textures
- `anim/*.json` — Pre-converted `AnimationPayloadDto`

Filename sanitization replaces non-`[a-zA-Z0-9_\-\.]` characters with `_`; keys longer than 140 characters take the trailing 80 chars + 12-hex SHA-256 hash suffix (`<tail80>_<sha12>.<ext>`).

---

## 4. Coordinate Conversion Contract (`CoordConvert.cs`)

CUE4Parse-Conversion exports `.glb` in **glTF 2.0 right-handed Y-up meters**, converted from **Unreal Engine left-handed Z-up centimeters**:

| Quantity | Unreal Engine (cm, Z-up, LH) | glTF / Three.js (m, Y-up, RH) | Method |
|---|---|---|---|
| Position / Translation | `(X, Y, Z)` cm | `(X * 0.01, Z * 0.01, Y * 0.01)` m | `CoordConvert.SwapPos` (`UnitScale = 0.01f`) |
| Direction Vector / Scale | `(X, Y, Z)` | `(X, Z, Y)` | `CoordConvert.SwapVector` / `SwapScale` |
| Quaternion | `(q.X, q.Y, q.Z, q.W)` | `(q.X, q.Z, q.Y, -q.W)` | `CoordConvert.SwapQuat` |
| Rotator | `(Pitch, Yaw, Roll)` deg | `SwapQuat(r.Quaternion())` | `CoordConvert.SwapRotatorToQuat` / `EulerDegUeToQuatYUp` |

Frontend runtime (`AnimationEngine.applyCutsceneActorTransform`) uses the identical swap `(X * 0.01, Z * 0.01, Y * 0.01)` and `(qx, qz, qy, -qw)` for cutscene actor transforms, plus an additional `-90°` (`-Math.PI / 2`) rotation around `+Y` for UE camera actors (UE camera forward is `+X`, Three.js camera forward is `-Z`).

---

## 5. Animation, KawaiiPhysics & Cutscenes

- **Animations (`AnimationService.cs` + `AnimationEngine.ts`)**:
  - Converts `UAnimSequence` / `UAnimMontage` (and paired `Rib_*` secondary ribbon layer when present via `?ribbonPath=`) using `USkeleton.ConvertAnims(...)` and `CoordConvert`.
  - Records `HasExplicitTrack`, `BoneRetargetMode`, and `FloatCurves` (morph curves).
  - `AnimationEngine` binds tracks to Three.js bones **case-insensitively**, handles `retargetTranslation` and `includeRootMotion`, layers `RibbonLayer` onto secondary/skirt/hair/cloak bones, and drives morph targets from float curves + manual overrides.
- **Physics (`PhysicsService.cs` + `KawaiiPhysicsSolver.ts`)**:
  - Inspects `ABP_*` and `*_PC` blueprints under the character directory for `KawaiiPhysicsGroup` structs (`RootBones`, `ExcludeBones`, damping/stiffness/radius/limit-angle curves, spherical/capsule/planar colliders).
  - Steps Verlet chain simulation per frame in `WuWaViewport.tsx` after skeletal pose updates and before `calibrateHeadBasis`.
- **Cutscenes (`CutsceneService.cs`)**:
  - Parses `LevelSequence` `MovieScene` sections: `MovieSceneSkeletalAnimationTrack` (with `MatchCharacterHint`), `MovieScene3DTransformTrack` (converted via `CoordConvert.UnitScale` & UE Euler→Quat), and `FloatTrack` camera `FocalLength` (converted to vertical FOV degrees from 36mm/20.25mm sensor dimensions).
