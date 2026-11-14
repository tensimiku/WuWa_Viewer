# Shaders, Material Classification & Texture Channels

WuWaViewer disables CUE4Parse's default glTF material export (`exportMaterials: false`) and constructs custom Three.js `ShaderMaterial` (Toon / Clay / Wireframe) and customized `MeshStandardMaterial` (PBR) instances inside `frontend/src/shaders/wuwaShaders.ts` from each section's `MaterialSlotDto`.

---

## 1. ShaderType Classification (`ModelService.ClassifyShaderType`)

Backend classification inspects the material instance name, parent material name, blend mode, and bound texture parameter names in **strict priority order**:

| Priority | Match Condition | `ShaderType` | Purpose |
|---|---|---|---|
| 1 | Name ends with `_OL` or parent contains `OL` | `"Outline"` | Inverted-hull extruded outline shell |
| 2 | Name contains `_FS`, `_Shadow`, or `FaceShadow` | `"FaceShadow"` | Secondary face SDF / shadow overlay |
| 3 | Parent/name contains `Distortion`, or (`_FX`/`FX_` and lacks `MainTex`/`BaseColor`/`Base`) | `"Distortion"` | Screen/refraction FX overlay |
| 4 | Name contains `_HETA` or `_HET` | `"HETA"` | Tear / eye-edge highlight overlay |
| 5 | Parent contains `SimpleEffect` / `AdvancedEffect`, or has `Base` without `MainTex` | `"Standard"` | Generic VFX / additive or translucent mesh |
| 6 | Name or parent contains `Face` | `"Face"` | Character face & SDF facial shadow shading |
| 7 | Name or parent contains `Eye` | `"Eye"` | Character eye shader (iridescence/emission) |
| 8 | Name or parent contains `Hair` or `Bangs` | `"Hair"` | Hair anisotropic/Kajiya-like specular |
| 9 | Name or parent contains `Body`, `Up`, `Down`, or `Cloth` | `"Body"` | Costume, body, limbs, cloth, fur, glass |
| 10 | Fallback | `"Standard"` | Weapons, props, uncategorized slots |

---

## 2. Texture Parameter Lookup, Color Spaces & Filtering

`createWuWaMaterialForSection` (`frontend/src/shaders/wuwaShaders.ts`) resolves material texture parameters with the following candidate priority order and GPU sampling rules (`TextureCache.load(path, srgb, clamp, nearest)`):

| Logical Role | Uniform / Variable | Texture Param Candidate Order | Color Space | Wrap / Filter |
|---|---|---|---|---|
| Diffuse / Albedo | `mainTex` (`uMainTex`) | `MainTex`, `BaseColor`, `Diffuse`, `Albedo`, `ColorMap`, `D`, `Base` | **sRGB** | Repeat / Linear + Mipmaps |
| Normal + ORM | `normalTex` (`uNormalTex`) | `Normal_Roughness_Metallic`, `NormalMap`, `Normal` | **Linear** (`NoColorSpace`) | Repeat / Linear + Mipmaps |
| Type / Material ID | `idTex` (`uIdTex`) | `TypeMask`, `IDTex`, `IDMap`, `RampMask`, `SwitchTex`, `ID` | **Linear** | Repeat / Linear + Mipmaps |
| Mask / Hair / SDF | `maskTex` (`uMaskTex`) | `MaskTex`, `Mask`, `MMap`, `HM`, `SDF` | **Linear** | Repeat / Linear + Mipmaps |
| Region ID | `rgidTex` (`uRgidTex`) | `RegionIDTex`, `RegionIdTex`, `RegionID` | **Linear** | **Repeat / `NearestFilter` / NO Mipmaps** |
| Toon Ramp LUT | `rampTex` (`uRampTex`) | `Ramp`, `RampTex`, `SkinRamp` | **sRGB** | **ClampToEdge / Linear / NO Mipmaps** |
| Emissive Map | `emTex` (`uEmTex`) | `EM`, `EmTex`, `EmissiveMap`, `Emissive` | **Linear** if `Eye`, else **sRGB** | Repeat / Linear + Mipmaps |
| Second Effect Map | `secondTex` | `Second_RGB`, `Second` | **sRGB** | Repeat / Linear + Mipmaps |
| Effect Noise/Mask | `noiseMaskTex` | `R_Noise_A_Mask` | **Linear** | Repeat / Linear + Mipmaps |
| Starry / Flow Noise | `commonNoiseTex` | `CommonNoiseMap` | **Linear** | Repeat / Linear + Mipmaps |
| Water Cloth Dissolve | `wcDissolveTex` | `WC_DissolveAndSDFTex`, `DissolveAndSDFTex` | **Linear** | Repeat / Linear + Mipmaps |
| Water Cloth Caustics | `wcCausticsTex` | `WC_CausticsTex`, `CausticsTex` | **Linear** | Repeat / Linear + Mipmaps |
| Fur Card Mask | `furTex` (`uFurTex`) | `Fur_Tex`, `FurTex`, `FurMask` | **Linear** | **ClampToEdge / Linear / NO Mipmaps** |

**Universal UV rule**: All textures are loaded with **`tex.flipY = false`** (matching glTF 2.0 / CUE4Parse top-left UV origin).

---

## 3. Packed Normal / Roughness / Metallic (`_N`) Convention

When the texture parameter contains `Normal_Roughness_Metallic` or the asset name ends with `_N` (`HAS_PACKED_NRM` / `HAS_WUWA_PACKED_NRM`):

| Channel | Data Stored | Shader Formula |
|---|---|---|
| **R, G** | Tangent-space Normal X, Y | `(rg * 2.0 - 1.0) * 0.52`, with reconstructed `Z = sqrt(max(1.0 - dot(xy, xy), 0.001))` |
| **B** | Metallic | `[0..1]` |
| **A** | Roughness | `[0..1]` |

*(Standard UE DirectX tangent-space convention; do not overwrite B/A when editing `_N` maps in external tools.)*

---

## 4. `CharV1` vs `CharV2` Opacity & Alpha Architecture (Critical)

WuWa uses **two completely different conventions** for where alpha/opacity is stored in `MainTex` vs `TypeMask`. Treating a `CharV2` material like `CharV1` causes missing/cut-out necks, chests, or clothing (the Daniya neck cutout bug).

### 4.1 UE Manifest Inputs vs Computed Shader Flags (Important Distinction)

Do not confuse **UE asset fields present in `/api/model/manifest`** with **internal variables computed at runtime in `wuwaShaders.ts`**:

- **In `/api/model/manifest` (`MaterialSlotDto`)**:
  - `parentName`: parent material name (e.g., contains `charv2` for V2 body materials)
  - `blendMode`: UE blend mode string (e.g., `"BLEND_Masked"`, `"BLEND_Translucent"`, `"BLEND_Opaque"`)
  - `switches`: `Record<string, boolean>` static switch parameters from the UE `UMaterialInstance` (e.g. `UseTranslucent`, `UseAlphaBlendMode`, `UVSwitchCharacterMode`, `UseRegionID`, `UseBlendParameter`, `UseRampIDMask`, `UseOnlySkinRampColor`, `UseHueShift`, `UseBlurTranslucentGlass`, `UseWaterCloth`, `UseFurry`, `HasBlendWaterMI`, `Use_WetClipMask`)
  - `scalars`: `Record<string, number>` (e.g. `OpacityMaskClipValue`, `SkinMin`, `SkinMax`, `TransClothMin`, `TransClothMax`, `WaterClothMin`, `WaterClothMax`)
  - `textures`: `Record<string, string>` (e.g. `MainTex`, `TypeMask`, `RegionIDTex`, `Normal_Roughness_Metallic`)
- **Computed inside `frontend/src/shaders/wuwaShaders.ts` (`resolveWuWaAlphaAndWetConfig`)**:
  - `isV2ShaderFamily`: true when `!Face && !Eye && !isEffectVfx && !isStarDecal` AND (`parentName` contains `charv2` OR any V2 switch above is true). *(Note: `UseDoubleSpecular` is intentionally excluded because CharV1 materials like `Kanteleila Alpha` and `Aogusita Cloth` also set it.)*
  - `isV2Opacity = isV2ShaderFamily && hasFtm`: selects **`TypeMask.r` (`uIdTex.r`)** instead of **`MainTex.a`** as the opacity channel (`useTypeMaskAlpha` / `#define USE_TYPEMASK_ALPHA`).
  - `v2MaskMode`: **viewer-only derived number** mapping UE5 V2 switches (`UseTranslucent ? 1 : UseAlphaBlendMode ? 2 : 0`, or `-1` when `!isV2Opacity`) to decide whether `TypeMask.r` clips/blends or renders solid `1.0`.

```json
// Example subset of one entry in manifest.materials[]
{
  "name": "MI_R2T1DaniyaMd10011Up01",
  "parentName": "MI_CharV2_Body",
  "shaderType": "Body",
  "blendMode": "BLEND_Masked",
  "scalars": { "SkinMin": 1, "SkinMax": 1, "OpacityMaskClipValue": 0.35 },
  "switches": { "UseRegionID": true, "UseTranslucent": false, "UseAlphaBlendMode": false },
  "textures": {
    "MainTex": "Client/.../T_..._D",
    "TypeMask": "Client/.../T_..._FTM",
    "RegionIDTex": "Client/.../T_..._RGID"
  }
}
```

### 4.2 Alpha Source & Cutout Matrix

| Material Generation | Opacity Source (`isV2Opacity`) | Role of `MainTex.a` (`_D.A`) | Cutout / Clip Behavior |
|---|---|---|---|
| **CharV1** (`!isV2Opacity`, e.g. `M_Char_Com` / `MI_Char_Body`) | **`MainTex.a`** (`uMainTex.a`) | Opacity / cutout mask (`alphaClip = 0.35`, `0.55` for `Star`/`XinHen` decals) | Clips when `MainTex.a * uOpacityIntensity < alphaTest` (`USE_ALPHATEST`, unless skin-protected) |
| **CharV2** (`isV2ShaderFamily && hasFtm`, e.g. `M_CharV2_Com` / `MI_CharV2_Body`) | **`TypeMask.r`** (`uIdTex.r`, via `USE_TYPEMASK_ALPHA`) | **Shadow / Specular / Breath** — **commonly `0` on neck/body skin** (e.g. `Daniya Up01`, `Daniya Up02`, `Mone Down`, `LinNai Alpha`)! | Controlled by UE switches (`v2MaskMode` in `wuwaShaders.ts`): |
| ↳ `v2MaskMode === 0` (`!UseTranslucent && !UseAlphaBlendMode`, e.g. `Daniya Up01`, `Aimisi Up01`) | Solid (`OpacityMask = 1.0`) | Shadow/Spec/Breath | **No alpha clipping** (`alphaTest = 0`) on base surface (unless `UseFurry`, `UseWaterCloth`, `HasBlendWaterMI`, or `useWetClipMask` overrides it) |
| ↳ `v2MaskMode > 0` (`UseTranslucent` = `1` or `UseAlphaBlendMode` = `2`, e.g. `Daniya Up02`, `Daniya Cloth`) | **`TypeMask.r`** | Shadow/Spec/Breath | Solid `BLEND_Masked` cloth/lace (`DaniyaCloth`, `MoneCloth`) without explicit sheer triggers (`BLEND_Translucent`, `Alpha`/`Tail`/`Glass` slot token, `UseTranslucentCloth`, `UseAlphaBlendMode`, `HasWetOverlayMI`, `TranslucentMask_Offset/Width`, `TranslucentDither > 0`, or `OpacityIntensity < 0.99`) stays **`alphaMode = 0`, `depthWrite = true`** with binary cutout (`effectiveAlphaClip = 0.3333` when raw `alphaClip === 0.35`; `RGID = Skin` stays protected opaque). Explicit sheer/translucent slots use **`alphaMode = 1`** (preserving `1.0` opacity where mask `>= 0.96` and `OpacityIntensity >= 0.99`). |

### 4.3 `RegionIDTex` (`_RGID`) Integer Packing & Protection
- `RegionIDTex` is sampled with `NearestFilter` and decoded as an exact integer ID:
  ```glsl
  float rgid = floor(texture2D(uRgidTex, uv).r * 255.0 + 0.5);
  ```
- Materials define inclusive uniform integer ID intervals:
  - `[uSkinMin..uSkinMax]` → Skin region (`wuIsSkinRgid`). When `uSkinProtect > 0.5`, skin pixels resist alpha-cutout discard and wet-alpha thinning.
  - `[uTransClothMin..uTransClothMax]` → Translucent/dissolvable cloth region.
  - `[uWaterClothMin..uWaterClothMax]` → Water-cloth region.

### 4.4 Fur Card Fin Cutout (`Fur_Tex` + `UV2`) vs `UseFurryParallax`
- Some costumes attach layered silhouette quad cards around cuffs/collars (e.g. `MI_R2T1DaniyaMd10011Fur`, `MI_R2T1ZanniMd20011Fur`, `MI_ERebeccadogMd10011_Fur`), while other cloth/alpha slots set `UseFurry = true` with `UseFurryParallax = true` (`MI_R2T1ZanniMd20011Down`, `MI_R2T1ZanniMd20011Alpha`) using cloth UVs instead of fur card tiles.
- **Detection rule (`useFurCard`)**: Enabled only when `furTex` (`Fur_Tex`/`FurTex`/`FurMask`), `UseFurry = true`, and `(!UseFurryParallax || slotNameOrParentContains('fur'))`.
- **Dual-UV sampling**: Base `MainTex`, `TypeMask`, and `RegionIDTex` still sample `UV0` (`vWuUv0`), whereas `uFurTex` samples **`UV2` (`TEXCOORD_2` → `vWuUv2`, `HAS_WUWA_UV2`)** (falling back to `UV0` if `uv2` is absent).
- **Clipping, Shadows & Sorting**:
  - Computes `wuFurMask = clamp(max(px.r, dot(px.rgb, vec3(0.3333))) * uFurAlphaInt, 0.0, 1.0)` (`FurAlphaIntensity`, e.g. `1.2` on `DaniyaFur`, default `1.0`) and `discard`s below `uFurAlphaClip` (`0.16..0.32`).
  - Masked fur slots (`!blendTranslucent`, e.g. `BLEND_Masked` even when `UseTranslucent = true` on CharV2) stay `alphaMode = 0` with `depthWrite = true`, skip `_OL` outline shells (`outlineMat = null`), disable Cloth-inherited `uUseEffectGlow`, and opt out of directional shadow casting/receiving (`WuWaViewport.tsx`, while PBR mode adds subtle `diffuseColor.rgb * 0.42` wrap fill) so crossed fur cards Z-sort cleanly without boxy outline borders or dark/blue shadow-map grid seams.
- **`COLOR_0.A` warning**: Exported fur card vertices commonly store **`COLOR_0.A = 0`** (`8628/8629` verts on `DaniyaFur`, `7675/7675` on `ZanniFur`) — **never multiply fur opacity by vertex color alpha**.

---

## 5. Wet Surface & Wet-Alpha System

### 5.1 Asset Discovery & Shared Rain Maps
- `ModelService.AttachWetOverlayMetadata` checks for per-material companion textures under `/Wet/<MI>_Darken`, `<MI>_Reflect` and alternate blend materials under `/BlendWater/<MI>_BlendWater`.
- `wuwaShaders.ts` pre-loads shared wet textures from `SHARED_WET_TEX_PATHS`:
  - `T_RainDrop_Draw_FTM`
  - `T_RainFlow_Draw_FTM`
  - `T_RainFlow_Proc_M`
  - `T_WetNoise_01`

### 5.2 Runtime Shading (`wuWaWetSurfaceGlsl` & `wuWaEvaluateAlphaGlsl`)
- **Surface Darkening & Fresnel Sheen**:
  - Activated when `uWetness > 0` and `uWetCapable > 0.5`.
  - Applies metallic-damped diffuse darkening (`mix(1.0, 0.55, metallic) * uWetDarkenStrength * porosityWeight`) and a view-angle Fresnel specular clearcoat (`pow(1.0 - NdotV, 3.1)`), plus a warm stocking rim tint when `uUseStocking > 0.5`.
  - **No temporal wave/ripple or animated streak noise** is applied when wet strength is increased (`wuWaWetSurfaceGlsl` uses smooth steady darkening + Fresnel).
- **Wet-Alpha (`uWetAlpha`)**:
  - Only enabled on materials that actually support wet transparency (`hasBlendWaterMI`, `useWaterCloth`, `useWetClipMask`, or matching `TransCloth` regions), NOT unconditionally on every character or every mesh slot.
  - Attenuates alpha smoothly on eligible cloth while respecting `uSkinProtect` and V2 `TypeMask.r` opacity.

---

## 6. Emissives, Eye Glow & Special VFX (`resolveWuWaEmissiveConfig`)

| Feature | Trigger / Parameters | Behavior |
|---|---|---|
| **Eye Shader** | `shaderType === 'Eye'` | Samples `EM` linearly; reads `UseDifferentColorEyes`, `LightEmissiveInt` (clamped `[0.25..2.2]`), `EmissionColor` / `EmissiveColor` / `EMColor` / `HeightLight_Color`, and `AniShapeColor` |
| **Alpha Breath / Suit Emission** | Not `Face`/`Hair`/`Eye`; `MainTex` has alpha range (`minAlpha01 < 0.96`); `UseBreathLight` or `EmissionBreathThreshold` / `BreatheStrength` / `EmissionStrength` / `EmissionIntensity` (or weapon + non-zero emissive color) | Drives breathing/accent glow on non-opaque alpha regions using `EmissionBreathThreshold` (capped at `0.965`) |
| **Secondary Effect Glow** | `UseEffectMaterial` or `R_Noise_A_Mask` + non-zero `Second_ColorTint` + (`R_Noise_A_Mask` or `Second_RGB`) | Adds `Second_ColorTint` emissive accent |
| **Starry Sky Shader** | `UseStarrySky` + `CommonNoiseMap` | Uses `TintColorFlowNight` / `TintColorFlowNight02` / `TintColorFlowDay` |
| **Effect / VFX Slots** | `!MainTex` + `Base` texture + (`SimpleEffect` / `AdvancedEffect` / `*_cm`) | Additive or Translucent blending tinted by `Base_ColorTint` |

---

## 7. Vertex Color (`COLOR_0`) & Outline Shells (`_OL`)

1. **Vertex Color `R` (`vColor.r`)**: Multiplies diffuse / ambient shading via `mix(0.76, 1.0, vColor.r)` to anchor baked AO/crevice shadows.
2. **Vertex Color `G` (`vColor.g`)**: Controls inverted-hull outline thickness on `_OL` shells (`outlineMat`). `0.0` collapses the outline (used on eyes/lips/fine detail); higher values thicken extruded backfaces.
3. **Outline Alpha Clipping (`outlineMat`)**:
   - Enabled only for **`CharV1`** outlines (`olMasked = !awCfg.isV2Opacity && ...`).
   - **`CharV2`** outline shells follow UE5 `WuwaToonBasePass_Outline.ush` and **do not discard pixels**, preventing neck/chin outline holes where `MainTex.a` is `0`.

---

## 8. Shader Modification Invariant (`customProgramCacheKey`)

When adding or changing GLSL branches, uniforms, `#define` flags (`USE_TYPEMASK_ALPHA`, `HAS_PACKED_NRM`, etc.), or `awCfg` conditions inside `frontend/src/shaders/wuwaShaders.ts`:

- **Always update `customProgramCacheKey()`** on `pbr` (`createWuWaMaterialForSection`), `mainMat`, and `olMat` whenever a new toggle affects the generated GLSL string or `#define` set.
- Three.js caches compiled WebGL programs by `customProgramCacheKey()`; omitting a new boolean from the cache key causes Three.js to silently reuse another material's compiled shader program.
- Notice Three.js geometry attributes checked by `createWuWaMaterialForSection` are `normal`, `uv1`, `uv2` (`TEXCOORD_2`, used for `HAS_WUWA_UV2` / `HAS_WUWA_FUR`), and `color` (GLB `COLOR_0`). Note that fur card vertices carry `COLOR_0.A = 0`.

---

## 9. External UE5 Shader Reference (`ref/ue5-wuwa-shader`)

A read-only sparse clone of `https://github.com/GachaWhisperer/ue5-wuwa-shader` is checked out at `ref/ue5-wuwa-shader/` (`../ref/ue5-wuwa-shader/` from `docs/`, containing `README.md` + `Plugins/WuwaToon/`, with root UE `.uasset` binaries omitted). Use it to verify unmapped texture channels, `StaticSwitch` combinations, or material parameter defaults:

| Area | Location under `ref/ue5-wuwa-shader/Plugins/WuwaToon/` | Key Files / Purpose |
|---|---|---|
| V2 Body shaders | `Shaders/Private/WuwaToonBasePass_V2Body.ush` | `M_CharV2_Com` body/cloth/fur/wet/alpha passes |
| V2 Hair & Face shaders | `Shaders/Private/WuwaToonBasePass_V2HairFace.ush` | `M_CharV2_Com` hair and face variants |
| CharV1 / Common / Eye / Outline | `Shaders/Private/` | `WuwaToonBasePass_Common.ush`, `WuwaToonBasePass_Face.ush`, `WuwaToonBasePass_Hair.ush`, `WuwaToonBasePass_Eye.ush`, `WuwaToonBasePass_Outline.ush` |
| Variant switch specs & registry | `Shaders/Private/Specs/` and `Specs/registry/` | Per-variant inputs/outputs JSON (`ToonBodyV2*.json`, `ToonFaceV2*.json`, `ToonHairV2*.json`); see `Specs/registry/README.md` |
| UE parameter / lighting defaults | `Content/Python/data/` | `kuro_mpc_defaults.json`, `kuro_toon_lighting_presets.json` |

**Agent reading rules**:
1. Never edit files inside `ref/ue5-wuwa-shader/`.
2. Files in `Shaders/Private/` and `Specs/` are large (e.g., `WuwaToonBasePass_V2Body.ush` is >9,000 lines); search with `rg`/`grep` for the parameter, switch, or root material first and read only the matching block.
3. `.ush` files contain DXBC-derived literals (`asfloat(0x...)`) and UE5 `GBufferA..D` outputs — never copy HLSL verbatim into `wuwaShaders.ts`; port only the channel mapping and shader logic into Three.js GLSL.
