# Blender Modding & Export Workflow (WuWaViewer Reference)

This guide gives technical artists, modders, and local agents the exact rules required to extract clean models from WuWaViewer, edit meshes/textures/weights in Blender, and export back without breaking WuWa shaders, outlines, animations, or KawaiiPhysics.

---

## 1. Extracting Base Assets (Model + Manifest + Textures)

WuWaViewer does not expose a browser "Download GLB" button; instead, extract files directly through the backend HTTP API (running on `http://localhost:5180`) or read them from `<CacheDir>`.

### 1.1 Discover Character Paths
Query a character summary (e.g. `FemaleMS/Daniya`):
```powershell
Invoke-RestMethod "http://localhost:5180/api/characters/FemaleMS/Daniya"
```
This returns `Variants[]` containing `PrimaryMeshPath`, `MeshParts[]`, and `Forms[]` (including modular forms such as `_Body` + `_Up2` and alternate `MI_`/texture form tags).

### 1.2 Download Manifest, GLB & PNGs
```powershell
$mesh = "Client/Content/Aki/Character/Role/FemaleMS/Daniya/R2T1DaniyaMd10011/Model/R2T1DaniyaMd10011"

# 1. Inspect manifest (material slot names, ShaderType, Switches, texture paths, sockets, morphs)
Invoke-RestMethod "http://localhost:5180/api/model/manifest?path=$([uri]::EscapeDataString($mesh))" `
  | ConvertTo-Json -Depth 10 | Set-Content "Daniya_manifest.json"

# 2. Download clean binary GLB (LOD0, morph targets included, no embedded materials)
Invoke-WebRequest "http://localhost:5180/api/model/glb?path=$([uri]::EscapeDataString($mesh))" `
  -OutFile "R2T1DaniyaMd10011.glb"

# 3. Download any texture path listed in manifest Materials[].Textures
$tex = "Client/Content/Aki/Character/Role/FemaleMS/Daniya/R2T1DaniyaMd10011/Model/T_R2T1DaniyaMd10011Bangs01_D"
Invoke-WebRequest "http://localhost:5180/api/texture?path=$([uri]::EscapeDataString($tex))" `
  -OutFile "T_R2T1DaniyaMd10011Bangs01_D.png"
```
Once requested once, these identical files are cached on disk under `<CacheDir>` (`WuWaViewer.Server/cache/` by default) in `manifest/`, `glb/`, and `tex/`.

*(Tip: Also check `GET /api/model/form-materials?path=...` to see alternate form materials/textures like `02`, `Switch02`, `Seq02`, `BlendWater`.)*

---

## 2. Blender Import & Coordinate System Contract

Backend `CoordConvert` (`WuWaViewer.Server/Services/CoordConvert.cs`) already exports `.glb` in standard **glTF 2.0 right-handed Y-up meters**:
- UE `(X, Y, Z) cm` → glTF `(X * 0.01, Z * 0.01, Y * 0.01) m`
- UE `FQuat(x, y, z, w)` → glTF `(x, z, y, -w)`

### Blender glTF Import (`File -> Import -> glTF 2.0`)
- Keep **Bone Dir** consistent with your target export workflow (default Blender glTF importer preserves node hierarchy cleanly; do **not** apply manual 90° root rotations on import and then export without matching transforms).
- Never merge or delete LOD0 primitive boundaries that map to distinct material slots unless intentionally removing a costume part.
- Verify in **Geometry Data -> Color Attributes** and **UV Maps** that:
  - `uv` (`UV0`), `uv1` (`UV1`, Face/Decal/FX), and `uv2` (`UV2`, Fur card tuft cutout atlas on `Fur` sections) survived import.
  - `COLOR_0` (Vertex Color) is present on body/hair/cloth meshes.
  - Shape Keys (morph targets) are populated for facial/blending sections.

---

## 3. Blender Editing & glTF Export Checklist

When modifying a character mesh for WuWa or re-testing in a glTF/Three.js viewer, preserve all of the following contracts:

### 3.1 Material Slots & Section Ordering
- `ModelService` aligns GLB mesh primitives 1:1 against LOD0 enabled `MaterialSlotDto` entries (`Name` / `ShaderType`).
- **Keep exact slot names** (e.g., `MI_R2T1DaniyaMd10011Up01`, `MI_R2T1DaniyaMd10011Hair01`, `MI_R2T1DaniyaMd10011Up1_OL`, `MI_R2T1DaniyaMd10011Face_FS`) and **do not split/reorder sections arbitrarily**, or shader assignment and overlay (`Outline` / `FaceShadow` / `HETA`) matching will misalign.

### 3.2 UVs (`flipY = false`)
- All textures in WuWaViewer load with **`tex.flipY = false`** (standard glTF top-left origin).
- Keep PNG textures in standard top-left orientation (do **not** vertically flip exported PNGs vs UVs).
- If present, preserve `UV1` (`uv1`, Face/Decals/FX) AND **`UV2` (`uv2`, `TEXCOORD_2`)** — card-fin `Fur` meshes sample base cloth texture on `UV0` and the `Fur_Tex` strand cutout atlas (`T_Fur02_M` / `T_Fur_M`) on **`UV2`**. Dropping `UV2` collapses fur cards back into solid rectangles.

### 3.3 Vertex Color Channels (`COLOR_0`)
WuWa shaders rely on specific channels of `COLOR_0`:

| Channel | Role in `wuwaShaders.ts` | Authoring Guidance in Blender |
|---|---|---|
| **R** | Baked crevice AO multiplier (`mix(0.76, 1.0, vColor.r)`) | Paint ~`1.0` on open lit areas, lower slightly in deep folds. **Avoid accidental `0.0` across newly added vertices** or the surface will darken abnormally. |
| **G** | **Outline thickness mask** on `_OL` extruded hull shells | Paint `0.0` on eyelash/eyebrow/lip interiors and thin alpha edges where outlines shouldn't bloat; ~`0.5–1.0` for standard ink line weight. |
| **B, A** | Material-specific UE weights / ancillary masks | Preserve original base weights when sculpting/transferring weights (`Data Transfer -> Color`). **Warning for Fur cards**: `COLOR_0.A` is **`0`** on fur card vertices (`DaniyaFur`, `ZanniFur`, `DogFur`) — never plug Vertex Color Alpha into Blender shader `Alpha`. |

- In Blender **Color Attributes**, export vertex colors as **Byte Color / Float Color in Linear space** without clamping everything to black.
- In Blender's **Export glTF 2.0** dialog (`Data -> Mesh`): ensure **Vertex Colors** (`Attributes -> Color`) are enabled, plus **Normals**, **UVs**, and **Tangents** (or allow Three.js computation).

### 3.4 Shape Keys (Morph Targets) & Corrective Pose Drivers
- `ModelService` exports all skeletal `MorphTargets` into the GLB (`exportMorphTargets: true`), so Blender imports them as **Shape Keys** (including facial curves like `E_Close`, `E_Smile_R`, `M_Laugh`, `Pupil_Scale`, face expression presets like `S_01`–`S_30`, and body/limb pose shapes like `L_P`/`L_F`/`L_B`/`L_Up`/`L_F_U`/`L_B_U`/`L_Up_U` and `R_*`).
- **Why raw GLBs do not auto-deform with bone rotation in Blender**:
  - In UE, corrective body morphs are driven by `USkeleton` `RBFDrivers` (paired with `*RBFPrecomputation` LUT assets) and helper bones (`Bone_Skirt*`, `Bone_Piao*`, `Bone_Hair*`) are driven by `AnimGraphNode_PoseDriver` nodes (`UPoseAsset`, e.g. `ABP_R2T1DaniyaMd10011_PC` driving skirt/hair helper bones via `PD_PoseAsset_Thigh` from `Bip001LThigh`/`Bip001RThigh`/`Bip001Head`).
  - Standard **glTF 2.0 (`.glb`) has no schema for bone-rotation-driven RBF Shape Key drivers or PoseDriver graphs**, so the bare `.glb` exports geometry + static Shape Keys with `0.0` default weights.
- **Built-in Blender RBF & PoseDriver Addon / CLI (`scripts/blender/wuwa_rbf_rig.py`)**:
  - Compatible with **Blender 4.2+ and 5.2 LTS** (single-file addon **or** headless CLI script), fed by `GET /api/rig/rbf?characterId=...` (or `?meshPath=...` / `?skeletonPath=...`).
  - **Blender UI Addon**: Install [`scripts/blender/wuwa_rbf_rig.py`](../scripts/blender/wuwa_rbf_rig.py) via *Edit → Preferences → Add-ons → Install from Disk*, then open **View3D → Sidebar (`N`) → WuWa Rig**:
    1. Click **Fetch & Apply RBF Rig** (from a running `WuWaViewer.Server`, e.g. `http://localhost:5180`) or **Apply from JSON File** (saved `/api/rig/rbf` response).
    2. Choose solver mode: **`Precompute LUT (Game Exact)`** (evaluates Kuro's exact `RBFPrecomputation` 2D bilinear lookup table + cross-driver `WeightModifier` suppression/boost) or **`Analytic RBF`** (smooth Gaussian solve from `DriveSettings` poses).
    3. Skirt/hair `PoseDriver` nodes create hidden non-deforming `MCH_PD_*` bones in collection `WuWa_PoseDriver_MCH` and attach additive `COPY_LOCATION` (`use_offset`) + `COPY_ROTATION` (`mix_mode='BEFORE'`) constraints so manual posing still layers cleanly on top.
  - **Headless CLI**:
    ```powershell
    blender -b --python scripts/blender/wuwa_rbf_rig.py -- `
      --glb path/to/Model.glb --url http://localhost:5180 --character FemaleMS/Daniya --save character_rigged.blend
    ```
    Supports `--json <file.json>`, `--mesh <uePath>`, `--skeleton <uePath>`, `--solver PRECOMPUTE|ANALYTIC`, `--no-pose-drivers`, and `--armature <name>`.
  - **Round-Trip Safety (Before Exporting Modded `.glb` / `.fbx` Back to WuWaViewer or UE)**:
    - Toggle **Export-Safe Mute (Safe for UE/glTF Export)** in the `WuWa Rig` panel (or run **Remove RBF Rig**) before exporting, so glTF/FBX export does not bake active preview morph weights or PoseDriver bone constraints on top of UE's runtime drivers.
    - For static renders or non-UE animation exports, click **Bake RBF to Keyframes** to write evaluated Shape Key curves and automatically mute live drivers.
- In Blender **Export glTF 2.0**:
  - Enable **Shape Keys** (`Data -> Shape Keys`).
  - **Do NOT check "Apply Modifiers"** on meshes that have Shape Keys (applying modifiers in Blender strips shape keys unless baked manually per key).
  - Never rename existing expression Shape Keys (`AnimationEngine` matches curve names directly).

### 3.5 Armature, Bone Hierarchy & KawaiiPhysics
- **Bone Naming**: `AnimationEngine` matches bone tracks **case-insensitively** against Three.js `Bone.name`. Do not rename `Bip001*`, `ik_*`, `vb_*`, dynamic `Bone_*` chains, or weapon socket bones.
- **KawaiiPhysics Chains**: `PhysicsService` extracts `RootBones` and `ExcludeBones` from `AnimNode_KawaiiPhysicsGroup` inside `ABP_*` / `*_PC` (for example `Bone_Hair032_L` / `Bone_Hair042_R`).
  - If you add new hair strands, ribbons, or cloth skirts, parent/weight them under existing dynamic `RootBones` (and respect `ExcludeBones`) rather than detaching bones or flattening hierarchy, or physics simulation (`KawaiiPhysicsSolver`) will ignore or detach them.
- **Weapon / Modular Sockets**: Preserve socket names (e.g., `WingCase`, `WeaponProp02Trail`, `LeftSuspensionCase`) listed in `manifest.Sockets` so `WuWaViewport.tsx` can mount `_Up2`/`_Up3`/weapon parts in the right coordinate frame.

### 3.6 Recommended Blender glTF 2.0 Export Settings
- Format: **glTF Binary (`.glb`)**
- Transform: **`+Y Up` checked** (default glTF 2.0 standard matching `CoordConvert`)
- Data → Mesh: **UVs**, **Normals**, **Vertex Colors (Attributes)** ON
- Data → Shape Keys: **ON**
- Data → Armature / Skinning: **Export Deformation Bones** checked carefully—**DO NOT strip non-deforming helper/socket/root bones** if animations, morphs, or `KawaiiPhysics` `RootBones` depend on them!
- Compression: Leave **Draco OFF** if inspecting raw GLBs in tools expecting uncompressed glTF buffers.

---

## 4. Texture Authoring Pitfalls (`_D`, `_N`, `_FTM`, `_RGID`)

Before editing any character texture in Photoshop/Substance/GIMP, verify in `<Char>_manifest.json` whether the target material is **`CharV1`** or **`CharV2`** (see [SHADERS_AND_TEXTURES.md](./SHADERS_AND_TEXTURES.md)):

1. **`_D` (`MainTex`)**:
   - Export as **sRGB RGBA PNG**.
   - **On `CharV1`**: `Alpha` controls opacity cutout (`< 0.35` clips). Painting `Alpha = 0` cuts holes in the mesh!
   - **On `CharV2` (e.g. `Daniya`, `Aimisi`, `Mone`, `Luhesi`, `Suisui`, `LinNai`)**: **`Alpha` is Shadow / Specular / Breath**, NOT opacity (`Alpha = 0..109` on skin is completely normal!). Do NOT treat `CharV2` `_D.A` as an opacity channel, and do NOT invert/fill `_D.A` to `255` globally or you will destroy specular/breath masking.
2. **`_FTM` / `_ID` (`TypeMask`)**:
   - Export as **Linear (`NoColorSpace`) PNG**.
   - **On `CharV2` (`MaskMode > 0`, translucent/masked clothing)**: **`R` channel controls Opacity** (`255` = opaque skin/fabric, `0` = clipped/transparent). When remodeling outfits on a `CharV2` character, edit **`_FTM.R`**—not `_D.A`—to cut lace, hems, or translucent trim.
3. **`_N` (`Normal_Roughness_Metallic`)**:
   - Export as **Linear PNG**, keeping all 4 channels intact:
     - `R, G` = Tangent normal X, Y (**DirectX `-Y` orientation** for UE).
     - `B` = **Metallic** (`0` = dielectric cloth/skin, `255` = bare metal).
     - `A` = **Roughness** (`0` = mirror glossy, `255` = completely matte).
   - Common Substance/Photoshop mistake: exporting an RGB normal map with `A = 255` and `B = 255` turns the entire outfit into rough chalky metal! Always re-pack Metallic into `B` and Roughness into `A`.
4. **`_RGID` (`RegionIDTex`)**:
   - Export as **Linear PNG** using **Nearest-Neighbor (hard pixel) sampling ONLY—NEVER blur, anti-alias, paint with soft brushes, or resize with bilinear/bicubic filtering!**
   - The shader reads `floor(r * 255.0 + 0.5)` to distinguish exact integer region IDs (e.g., `Skin` vs `TransCloth` vs `WaterCloth`). Anti-aliased boundary pixels create intermediate IDs that bypass `uSkinProtect` and cause ragged silhouette holes or glowing seams.

---

## 5. Verifying Changes in WuWaViewer

After modifying shader, manifest, physics, or animation code in WuWaViewer (or testing modded viewer behavior):
1. Clear stale disk cache (`WuWaViewer.Server/bin/.../cache` or configured `CacheDir`) if backend DTO/manifest/export code changed.
2. Run typecheck + production bundle:
   ```powershell
   cd frontend
   npx tsc --noEmit
   npm run build
   ```
3. Visually verify in the running viewer (`http://localhost:5173`):
   - Check all render modes (`Toon`, `PBR`, `Clay`, `Wireframe`) for skin/neck continuity (no cutout holes on `CharV1` or `CharV2`), `_OL` outline continuity, and `COLOR_0.G` outline weights.
   - Toggle **Forms / Presets** (`기본 폼`, `변신 폼 (Up2)`, `02`, `Switch02`) and check seam alignment on swapped parts.
   - Test **Wetness** (`0 -> 1`) and **Wet-Alpha** sliders: confirm skin stays protected (`uSkinProtect`), eligible cloth darkens smoothly without ripple noise, and wet alpha affects only supported outfits.
   - Play idle / combat **Animations** + **KawaiiPhysics** + **Cutscenes** to confirm morph curves and secondary physics chains remain intact.
4. Keep changes isolated from `CUE4Parse/` / `ref/` (read-only upstream submodules/references).

---

## 6. UE4 `.pak` Mod Export & Loading Scope

- **Game Archive Format**: Wuthering Waves uses standard **UE4 `.pak` + `.sig`** chunks under `Client/Content/Paks/` (not UE5 `.utoc`/`.ucas` IoStore).
- **Saving `.glb` → `.pak` (Not Built Into WuWaViewer)**:
  - WuWaViewer and its underlying `CUE4Parse` library are **strictly read-only** — they cannot cook `.uasset`/`.uexp` assets or build `.pak` files.
  - Producing a working per-character `.pak` mod requires importing the edited `.fbx`/`.glb` into a matching UE4 project/cooker to generate valid `.uasset`/`.uexp` payloads (matching exact Skeleton, Material slots, and MorphTarget structure), then packing the `Client/Content/Aki/...` hierarchy into a `_P.pak` archive with `UnrealPak` or `repak`.
- **Loading External `.pak` Mods Back Into WuWaViewer**:
  - `GameAssetService` creates `DefaultFileProvider` over `Client/Content/Paks` with `SearchOption.AllDirectories` and calls `SubmitKeys(...)` (which includes the default unencrypted GUID `0000...`).
  - CUE4Parse's `AbstractVfsReader.VerifyReadOrder()` assigns higher `ReadOrder` (`> 100` vs `3` for base paks) to archives ending in **`_P.pak`** (`FileProviderDictionary` resolves lookups by descending `ReadOrder`).
  - Placing an unencrypted (or key-matching) cooked mod archive such as `Client/Content/Paks/~mods/MyCharMod_P.pak` and clearing `<CacheDir>` (`manifest/` & `glb/` & `tex/`) allows WuWaViewer to mount and read overridden assets when restarted, provided the modded `.uasset` matches WuWa's UE serialization layout.
