import * as THREE from 'three';
import { api } from '../api';
import type { MaterialSlotDto, ModelManifestDto, ShaderRenderMode } from '../types';

export interface ToonRuntimeUniforms {
  uLightDir: { value: THREE.Vector3 };
  uLightColor: { value: THREE.Color };
  uAmbientColor: { value: THREE.Color };
  uHeadForward: { value: THREE.Vector3 };
  uHeadRight: { value: THREE.Vector3 };
  uOutlineWidthScale: { value: number };
  uOutlineColorTint: { value: THREE.Color };
  uSdfFlipX: { value: number };
  uSdfOffset: { value: number };
  uToonContrast: { value: number };
  uWetness: { value: number };
  uWetAlpha: { value: number };
  uWetTime: { value: number };
  uWetRainDropTex: { value: THREE.Texture };
  uWetRainFlowTex: { value: THREE.Texture };
  uWetRainProcTex: { value: THREE.Texture };
  uWetNoiseTex: { value: THREE.Texture };
}

export function createSharedToonUniforms(): ToonRuntimeUniforms {
  return {
    uLightDir: { value: new THREE.Vector3(0.45, 0.72, 0.53).normalize() },
    uLightColor: { value: new THREE.Color('#fff9f2') },
    uAmbientColor: { value: new THREE.Color('#475569') },
    uHeadForward: { value: new THREE.Vector3(0, 0, 1) },
    uHeadRight: { value: new THREE.Vector3(-1, 0, 0) },
    uOutlineWidthScale: { value: 1.0 },
    uOutlineColorTint: { value: new THREE.Color('#16141a') },
    uSdfFlipX: { value: 1.0 },
    uSdfOffset: { value: 0.0 },
    uToonContrast: { value: 1.0 },
    uWetness: { value: 0.0 },
    uWetAlpha: { value: 0.85 },
    uWetTime: { value: 0.0 },
    uWetRainDropTex: { value: texCache.black },
    uWetRainFlowTex: { value: texCache.black },
    uWetRainProcTex: { value: texCache.black },
    uWetNoiseTex: { value: texCache.white }
  };
}

const SHARED_WET_TEX_PATHS = {
  rainDrop: 'Client/Content/Aki/Character/Role/CommonTexture/Wet/T_RainDrop_Draw_FTM',
  rainFlow: 'Client/Content/Aki/Character/Role/CommonTexture/Wet/T_RainFlow_Draw_FTM',
  rainProc: 'Client/Content/Aki/Character/Role/CommonTexture/Wet/T_RainFlow_Proc_M',
  wetNoise: 'Client/Content/Aki/Render/Common/T_WetNoise_01'
} as const;

type WetTextureTuple = [THREE.Texture | null, THREE.Texture | null, THREE.Texture | null, THREE.Texture | null];
let sharedWetTexBundlePromise: Promise<WetTextureTuple> | null = null;

/** Shared common wet maps (raindrops, flow streaks, wet noise) loaded once with RepeatWrapping. */
export function ensureSharedWetTextures(shared: ToonRuntimeUniforms): Promise<void> {
  if (!sharedWetTexBundlePromise) {
    sharedWetTexBundlePromise = Promise.all([
      texCache.load(SHARED_WET_TEX_PATHS.rainDrop, false, false),
      texCache.load(SHARED_WET_TEX_PATHS.rainFlow, false, false),
      texCache.load(SHARED_WET_TEX_PATHS.rainProc, false, false),
      texCache.load(SHARED_WET_TEX_PATHS.wetNoise, false, false)
    ]);
  }
  return sharedWetTexBundlePromise.then(([rainDrop, rainFlow, rainProc, wetNoise]) => {
    if (rainDrop) shared.uWetRainDropTex.value = rainDrop;
    if (rainFlow) shared.uWetRainFlowTex.value = rainFlow;
    if (rainProc) shared.uWetRainProcTex.value = rainProc;
    if (wetNoise) shared.uWetNoiseTex.value = wetNoise;
  });
}

class TextureCache {
  private readonly loader = new THREE.TextureLoader();
  private readonly cache = new Map<string, Promise<THREE.Texture | null>>();
  private fallbackWhite: THREE.DataTexture | null = null;
  private fallbackNormal: THREE.DataTexture | null = null;
  private fallbackBlack: THREE.DataTexture | null = null;

  public get white(): THREE.DataTexture {
    if (!this.fallbackWhite) {
      const d = new Uint8Array([255, 255, 255, 255]);
      this.fallbackWhite = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
      this.fallbackWhite.needsUpdate = true;
    }
    return this.fallbackWhite;
  }

  public get black(): THREE.DataTexture {
    if (!this.fallbackBlack) {
      const d = new Uint8Array([0, 0, 0, 255]);
      this.fallbackBlack = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
      this.fallbackBlack.needsUpdate = true;
    }
    return this.fallbackBlack;
  }

  public get flatNormal(): THREE.DataTexture {
    if (!this.fallbackNormal) {
      const d = new Uint8Array([128, 128, 255, 255]);
      this.fallbackNormal = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
      this.fallbackNormal.needsUpdate = true;
    }
    return this.fallbackNormal;
  }

  public load(path: string | undefined, srgb: boolean, clamp = false, nearest = false): Promise<THREE.Texture | null> {
    if (!path) return Promise.resolve(null);
    const key = `${path}::${srgb ? 'srgb' : 'lin'}::${clamp ? 'clamp' : 'wrap'}::${nearest ? 'nn' : 'lin'}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    const p = new Promise<THREE.Texture | null>((resolve) => {
      const url = api.textureUrl(path);
      this.loader.load(
        url,
        (tex) => {
          tex.flipY = false; // glTF / CUE4Parse UVs use top-left origin
          tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          tex.wrapS = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
          tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
          tex.generateMipmaps = !clamp && !nearest;
          tex.minFilter = nearest
            ? THREE.NearestFilter
            : clamp
              ? THREE.LinearFilter
              : THREE.LinearMipmapLinearFilter;
          tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
          tex.userData.minAlpha01 = inspectMinAlpha01(tex.image);
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        () => resolve(null)
      );
    });
    this.cache.set(key, p);
    return p;
  }
}

function inspectMinAlpha01(img: unknown): number {
  try {
    const drawable = img as CanvasImageSource & { width?: number; height?: number };
    if (!drawable || !drawable.width || !drawable.height || typeof document === 'undefined') return 0;
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    ctx.drawImage(drawable, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    let minA = 255;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < minA) minA = data[i];
    }
    return minA / 255;
  } catch {
    return 0;
  }
}

export const texCache = new TextureCache();

function isRealTexPath(path: string | undefined): path is string {
  if (!path) return false;
  const low = path.toLowerCase();
  const base = low.slice(low.lastIndexOf('/') + 1);
  return !base.startsWith('t_default');
}

function pickTex(slot: MaterialSlotDto | undefined, candidates: string[]): string | undefined {
  if (!slot) return undefined;
  for (const c of candidates) {
    for (const [k, v] of Object.entries(slot.textures)) {
      if (k.toLowerCase() === c.toLowerCase()) return v;
    }
  }
  for (const c of candidates) {
    if (c.length < 4) continue;
    for (const [k, v] of Object.entries(slot.textures)) {
      if (k.toLowerCase().includes(c.toLowerCase())) return v;
    }
  }
  return undefined;
}

function hasTexKeyContaining(slot: MaterialSlotDto | undefined, needle: string): boolean {
  if (!slot) return false;
  const low = needle.toLowerCase();
  return Object.keys(slot.textures).some((k) => k.toLowerCase().includes(low));
}

function pickScalar(slot: MaterialSlotDto | undefined, names: string[], fallback: number): number {
  if (!slot) return fallback;
  for (const n of names) {
    for (const [k, v] of Object.entries(slot.scalars)) {
      if (k.toLowerCase() === n.toLowerCase()) return v;
    }
  }
  return fallback;
}

function hasScalarKey(slot: MaterialSlotDto | undefined, names: string[]): boolean {
  if (!slot) return false;
  const set = new Set(names.map((n) => n.toLowerCase()));
  return Object.keys(slot.scalars).some((k) => set.has(k.toLowerCase()));
}

function pickVec(slot: MaterialSlotDto | undefined, names: string[], fallback: [number, number, number, number]): [number, number, number, number] {
  if (!slot) return fallback;
  for (const n of names) {
    for (const [k, v] of Object.entries(slot.vectors)) {
      if (k.toLowerCase() === n.toLowerCase() && v.length >= 3) {
        return [v[0], v[1], v[2], v.length >= 4 ? v[3] : 1];
      }
    }
  }
  return fallback;
}

function pickNonZeroVec(slot: MaterialSlotDto | undefined, names: string[], fallback: [number, number, number, number]): [number, number, number, number] {
  if (!slot) return fallback;
  for (const n of names) {
    for (const [k, v] of Object.entries(slot.vectors)) {
      if (k.toLowerCase() === n.toLowerCase() && v.length >= 3 && Math.max(v[0], v[1], v[2]) > 0.004) {
        return [v[0], v[1], v[2], v.length >= 4 ? v[3] : 1];
      }
    }
  }
  return fallback;
}

function pickSwitch(slot: MaterialSlotDto | undefined, names: string[], fallback = false): boolean {
  if (!slot) return fallback;
  for (const n of names) {
    for (const [k, v] of Object.entries(slot.switches)) {
      if (k.toLowerCase() === n.toLowerCase()) return v;
    }
  }
  return fallback;
}

function toneMapHdrEmissive(vec: [number, number, number, number]): THREE.Vector3 {
  const r = Math.max(0, vec[0]);
  const g = Math.max(0, vec[1]);
  const b = Math.max(0, vec[2]);
  const m = Math.max(r, g, b);
  if (m <= 1e-4) return new THREE.Vector3(0, 0, 0);
  if (m <= 1.0) return new THREE.Vector3(r, g, b);
  const compressed = Math.min(1.7, 1.0 + 0.36 * Math.log(m));
  const s = compressed / m;
  return new THREE.Vector3(r * s, g * s, b * s);
}

interface WuWaEmissiveConfig {
  isEffectVfx: boolean;
  vfxAdditive: boolean;
  vfxTranslucent: boolean;
  vfxTint: THREE.Vector3;
  useEyeEm: boolean;
  eyeDiffColors: number;
  eyeEmInt: number;
  eyeGlowColor: THREE.Vector3;
  aniShapeColor: THREE.Vector3;
  useAlphaEmission: boolean;
  emThreshold: number;
  emColor: THREE.Vector3;
  emStrength: number;
  useEffectGlow: boolean;
  secondGlowColor: THREE.Vector3;
  useStarrySky: boolean;
  starryColor: THREE.Vector3;
}

function resolveWuWaEmissiveConfig(
  slot: MaterialSlotDto | undefined,
  effectiveShaderKind: string,
  mainTex: THREE.Texture | null,
  emTex: THREE.Texture | null,
  hasNoiseMaskTex: boolean,
  hasSecondTex: boolean,
  hasCommonNoiseTex: boolean,
  isFireMat: boolean,
  isWeapon: boolean
): WuWaEmissiveConfig {
  const nameL = slot?.name?.toLowerCase() ?? '';
  const parentL = slot?.parentName?.toLowerCase() ?? '';
  const baseTexPath = pickTex(slot, ['Base']);
  const mainTexPath = pickTex(slot, ['MainTex', 'BaseColor', 'Diffuse', 'Albedo', 'ColorMap', 'D']);

  const isEffectVfx = Boolean(
    !mainTexPath &&
    isRealTexPath(baseTexPath) &&
    (parentL.includes('simpleeffect') || parentL.includes('advancedeffect') || nameL.endsWith('_cm'))
  );
  const vfxAdditive = isEffectVfx && Boolean(slot?.blendMode?.includes('Additive'));
  const vfxTranslucent = isEffectVfx && Boolean(slot?.blendMode?.includes('Translucent') || slot?.blendMode?.includes('AlphaComposite'));
  const vfxTint = toneMapHdrEmissive(pickVec(slot, ['Base_ColorTint'], [1, 1, 1, 1]));

  const useEyeEm = !isEffectVfx && effectiveShaderKind === 'Eye';
  const eyeDiffColors = pickSwitch(slot, ['UseDifferentColorEyes'], false) ? 1.0 : 0.0;
  const rawEyeInt = pickScalar(slot, ['LightEmissiveInt', 'EmissionStrength', 'EmissiveIntensity', 'BreatheStrength'], 0.65);
  const eyeEmInt = Math.min(Math.max(rawEyeInt > 0 ? rawEyeInt : 0.45, 0.25), 2.2);
  const eyeGlowRaw = pickNonZeroVec(slot, ['EmissionColor', 'EmissiveColor', 'EMColor', 'HeightLight_Color'], [0.55, 0.72, 1.0, 1.0]);
  const eyeGlowColor = toneMapHdrEmissive(eyeGlowRaw);
  const aniShapeRaw = pickNonZeroVec(slot, ['AniShapeColor'], [0, 0, 0, 0]);
  const aniShapeColor = toneMapHdrEmissive(aniShapeRaw);

  const rawEmColor = pickNonZeroVec(
    slot,
    ['EmissiveColor', 'EmissionColor', 'EMColor'],
    isFireMat ? [1.0, 0.55, 0.2, 1] : [1.0, 1.0, 1.0, 1.0]
  );
  const emColor = toneMapHdrEmissive(rawEmColor);
  const hasExplicitEmColor = pickNonZeroVec(slot, ['EmissiveColor', 'EmissionColor', 'EMColor'], [0, 0, 0, 0]).slice(0, 3).some((c) => c > 0.004);

  const hasAlphaChannelMask = Boolean(mainTex && (mainTex.userData?.minAlpha01 ?? 0) < 0.96);
  const useBreathSwitch = pickSwitch(slot, ['UseBreathLight'], false);
  const hasBreathParams = hasScalarKey(slot, ['EmissionBreathThreshold', 'BreatheStrength', 'EmissionStrength', 'EmissionIntensity']);
  const useAlphaEmission = Boolean(
    !isEffectVfx &&
    hasAlphaChannelMask &&
    effectiveShaderKind !== 'Face' &&
    effectiveShaderKind !== 'Hair' &&
    effectiveShaderKind !== 'Eye' &&
    (useBreathSwitch || hasBreathParams || (isWeapon && hasExplicitEmColor))
  );

  const emThreshold = Math.min(pickScalar(slot, ['EmissionBreathThreshold'], 0.9), 0.965);
  const breatheStr = pickScalar(slot, ['BreatheStrength'], 0);
  const directStr = pickScalar(slot, ['EmissionStrength', 'EmissiveIntensity', 'EMIntensity', 'EmissionIntensity'], 0);
  const metalEmStr = pickScalar(slot, ['MetalEmissionStrength'], 0);
  const emStrength = useAlphaEmission
    ? Math.min(Math.max(directStr * 0.85, breatheStr * 0.45, metalEmStr * 0.4, 0.75), 1.6)
    : Math.min(Math.max(directStr, emTex ? 0.75 : (isFireMat ? 0.55 : 0.0)), 1.6);

  const secTint = pickNonZeroVec(slot, ['Second_ColorTint'], [0, 0, 0, 0]);
  const hasSecondTint = Math.max(secTint[0], secTint[1], secTint[2]) > 0.01;
  const useEffectGlow = Boolean(
    !isEffectVfx &&
    hasSecondTint &&
    (hasNoiseMaskTex || hasSecondTex) &&
    (pickSwitch(slot, ['UseEffectMaterial'], false) || hasNoiseMaskTex)
  );
  const secondGlowColor = toneMapHdrEmissive(secTint);

  const useStarrySky = Boolean(!isEffectVfx && pickSwitch(slot, ['UseStarrySky'], false) && hasCommonNoiseTex);
  const starryNight = pickNonZeroVec(slot, ['TintColorFlowNight', 'TintColorFlowNight02', 'TintColorFlowDay'], [0.15, 0.65, 1.0, 1.0]);
  const starryColor = toneMapHdrEmissive(starryNight);

  return {
    isEffectVfx,
    vfxAdditive,
    vfxTranslucent,
    vfxTint,
    useEyeEm,
    eyeDiffColors,
    eyeEmInt,
    eyeGlowColor,
    aniShapeColor,
    useAlphaEmission,
    emThreshold,
    emColor,
    emStrength,
    useEffectGlow,
    secondGlowColor,
    useStarrySky,
    starryColor
  };
}

function wuWaEmissiveUniformDecls(): string {
  return `
    uniform sampler2D uSecondTex;
    uniform sampler2D uNoiseMaskTex;
    uniform sampler2D uCommonNoiseTex;
    uniform vec3 uEmColor;
    uniform float uEmStrength;
    uniform float uUseAlphaEmission;
    uniform float uEmThreshold;
    uniform float uUseEffectGlow;
    uniform vec3 uSecondGlowColor;
    uniform float uUseStarrySky;
    uniform vec3 uStarryColor;
    uniform float uEyeDiffColors;
    uniform float uEyeEmInt;
    uniform vec3 uEyeGlowColor;
    uniform vec3 uAniShapeColor;
    uniform vec3 uVfxTint;
    uniform float uVfxAlphaClip;`;
}

function wuWaEmissiveComputeGlsl(
  uvExpr: string,
  baseVar: string,
  outVar: string,
  isEyeExpr: string
): string {
  return `
    vec3 ${outVar} = vec3(0.0);
    if (${isEyeExpr}) {
      float wuIrisMask = 0.0;
      float wuCrescent = 0.0;
      float wuPupilSpot = 0.0;
      vec2 wuEyeTileUv = uEyeDiffColors > 0.5 ? vec2(fract(${uvExpr}.x * 2.0), ${uvExpr}.y) : ${uvExpr};
      #ifdef HAS_EM_TEX
        vec4 wuEyeEm = texture2D(uEmTex, ${uvExpr});
        wuIrisMask = clamp(1.0 - wuEyeEm.g, 0.0, 1.0);
        wuCrescent = texture2D(uEmTex, wuEyeTileUv).r * wuIrisMask;
        wuPupilSpot = smoothstep(0.15, 0.85, 1.0 - wuEyeEm.a);
      #else
        wuIrisMask = smoothstep(0.72, 0.35, dot(${baseVar}.rgb, vec3(0.299, 0.587, 0.114)));
      #endif
      float wuCatchMain = smoothstep(0.068, 0.042, length((wuEyeTileUv - vec2(0.39, 0.38)) * vec2(1.0, 1.2)));
      float wuCatchSec = smoothstep(0.036, 0.020, length((wuEyeTileUv - vec2(0.61, 0.59)) * vec2(1.1, 1.1))) * 0.75;
      float wuCatch = wuCatchMain + wuCatchSec;
      float wuMaxC = max(${baseVar}.r, max(${baseVar}.g, ${baseVar}.b));
      ${outVar} += ${baseVar}.rgb * wuIrisMask * (0.24 + 0.24 * uEyeEmInt);
      ${outVar} += mix(${baseVar}.rgb * 1.35 + uEyeGlowColor * 0.45, uEyeGlowColor, 0.55) * wuCrescent * (0.35 + 0.50 * uEyeEmInt);
      ${outVar} += uAniShapeColor * wuPupilSpot * wuMaxC * 0.65;
      ${outVar} += mix(vec3(1.0, 0.99, 0.98), uEyeGlowColor, 0.18) * wuCatch * wuIrisMask * 0.72;
      #ifdef HAS_NOISE_MASK_TEX
        float wuEyeFx = texture2D(uNoiseMaskTex, vec2(wuEyeTileUv.x * 0.5, wuEyeTileUv.y)).r;
        ${outVar} += uEyeGlowColor * wuEyeFx * wuIrisMask * 0.55;
      #endif
    } else {
      if (uUseAlphaEmission > 0.5) {
        float wuAlphaM = smoothstep(uEmThreshold - 0.06, min(uEmThreshold + 0.02, 0.995), ${baseVar}.a);
        ${outVar} += mix(${baseVar}.rgb, vec3(1.0), 0.42) * uEmColor * uEmStrength * wuAlphaM;
      }
      #ifdef HAS_EM_TEX
        ${outVar} += texture2D(uEmTex, ${uvExpr}).rgb * uEmColor * uEmStrength;
      #endif
      if (uUseEffectGlow > 0.5) {
        float wuEffPat = 1.0;
        #ifdef HAS_NOISE_MASK_TEX
          vec4 wuNm = texture2D(uNoiseMaskTex, ${uvExpr});
          wuEffPat *= max(wuNm.r, wuNm.a < 0.99 ? wuNm.a : 0.0);
        #endif
        vec3 wuSecCol = vec3(1.0);
        #ifdef HAS_SECOND_TEX
          wuSecCol = texture2D(uSecondTex, ${uvExpr}).rgb;
        #endif
        ${outVar} += wuSecCol * uSecondGlowColor * wuEffPat * 0.72;
      }
      if (uUseStarrySky > 0.5) {
        float wuSkyMask = 1.0;
        #ifdef HAS_ID_TEX
          wuSkyMask = mix(0.25, 1.0, texture2D(uIdTex, ${uvExpr}).b);
        #endif
        vec3 wuStars = vec3(0.0);
        #ifdef HAS_COMMON_NOISE_TEX
          wuStars = texture2D(uCommonNoiseTex, ${uvExpr} * 1.35).rgb * 1.4
                  + texture2D(uCommonNoiseTex, ${uvExpr} * 2.15 + vec2(0.19, 0.37)).rgb * 0.9;
        #endif
        ${outVar} += uStarryColor * (0.08 + wuStars * 2.4) * wuSkyMask;
      }
    }`;
}

export interface WuWaAlphaWetConfig {
  alphaMode: 0 | 1 | 2 | 3; // 0 = opaque/masked, 1 = translucent cloth/veil, 2 = blur glass, 3 = water cloth / blend water
  isTransparentMaterial: boolean;
  depthWrite: boolean;
  alphaTest: number;
  isV2Opacity: boolean;
  v2MaskMode: number;
  useSkinProtect: boolean;
  useGlslCutout: boolean;
  isMixedSkinSlot: boolean;
  isHairTranslucent: boolean;
  hasWetClipMask: boolean;
  useTranslucentCloth: boolean;
  opacityIntensity: number;
  glassOpacity: number;
  skinMin: number;
  skinMax: number;
  transClothMin: number;
  transClothMax: number;
  hasTransClothRange: boolean;
  waterClothMin: number;
  waterClothMax: number;
  hasWaterClothRange: boolean;
  hasWetOverlayMI: boolean;
  hasBlendWaterMI: boolean;
  wetCapable: boolean;
  wetAlphaCapable: number;
  wetDarkenStrength: number;
  wetRoughnessMin: number;
  useStocking: boolean;
  useFurCard: boolean;
  furAlphaIntensity: number;
  wcEdgeColor1: THREE.Vector3;
  wcEdgeColor2: THREE.Vector3;
  wcEdgeColor3: THREE.Vector3;
  wcRefractColor: THREE.Vector3;
}

export function resolveWuWaAlphaAndWetConfig(
  slot: MaterialSlotDto | undefined,
  effectiveShaderKind: string,
  emCfg: ReturnType<typeof resolveWuWaEmissiveConfig>,
  hasFtm: boolean,
  _hasMainTex: boolean,
  isStarDecal: boolean,
  isMasked: boolean,
  alphaClip: number,
  hasFurTex = false
): WuWaAlphaWetConfig {
  const slotNameL = slot?.name?.toLowerCase() ?? '';
  const parentNameL = slot?.parentName?.toLowerCase() ?? '';
  const assetL = slot?.assetPath?.toLowerCase() ?? '';

  const hasWetOverlayMI = pickSwitch(slot, ['HasWetOverlayMI'], false);
  const useWaterCloth =
    !emCfg.isEffectVfx &&
    !isStarDecal &&
    effectiveShaderKind !== 'Eye' &&
    effectiveShaderKind !== 'Face' &&
    effectiveShaderKind !== 'Hair' &&
    pickSwitch(slot, ['UseWaterCloth'], false);
  const useBlurGlass =
    !emCfg.isEffectVfx &&
    !isStarDecal &&
    effectiveShaderKind !== 'Eye' &&
    effectiveShaderKind !== 'Face' &&
    pickSwitch(slot, ['UseBlurTranslucentGlass'], false);
  const useTranslucentCloth = pickSwitch(slot, ['UseTranslucentCloth'], false);
  const useTranslucentSwitch = pickSwitch(slot, ['UseTranslucent'], false);
  const hasSkinWet = pickSwitch(slot, ['Use_SkinPBR_Wet'], false);
  const useCharWet = pickSwitch(slot, ['Use_Char_Wet', 'WetMI_Use_Char_Wet'], false);
  const useWetClipMask = pickSwitch(slot, ['Use_WetClipMask', 'WetMI_Use_WetClipMask'], false);
  const useStocking = pickSwitch(slot, ['UseStocking', 'UseStockings'], false);
  const blendTranslucent = Boolean(slot?.blendMode?.includes('Translucent')) && !isStarDecal && !emCfg.isEffectVfx;

  const hasSheerToken = ['alpha', 'cloth', 'glass', 'tail', 'leisi', 'fur'].some((t) => slotNameL.includes(t));
  const hasMixedBodyToken = slotNameL.includes('down') || slotNameL.includes('up') || slotNameL.includes('body');
  const hasBlendWaterMI =
    effectiveShaderKind === 'Body' &&
    !emCfg.isEffectVfx &&
    !isStarDecal &&
    (pickSwitch(slot, ['HasBlendWaterMI'], false) || assetL.includes('blendwater') || parentNameL.includes('blendwater'));
  const useAlphaBlendMode = pickSwitch(slot, ['UseAlphaBlendMode'], false);
  const useFurry = pickSwitch(slot, ['UseFurry'], false);
  const useFurryParallax = pickSwitch(slot, ['UseFurryParallax'], false);
  const isFurSlotName = slotNameL.includes('fur') || parentNameL.includes('fur');
  // Card-fin Fur materials (e.g. DaniyaFur, ZanniFur, DogFur) mask with Fur_Tex(uv2);
  // UseFurryParallax cloth/alpha materials (e.g. ZanniDown, ZanniAlpha) use parallax cloth math instead.
  const useFurCard = Boolean(hasFurTex && useFurry && (!useFurryParallax || isFurSlotName));
  const rawFurAlphaInt = pickScalar(slot, ['FurAlphaIntensity'], 1.0);
  const furAlphaIntensity = Math.min(Math.max(rawFurAlphaInt, 0.25), 3.0);
  // M_CharV2_Com (MI_CharV2_Body and children) packs Shadow/Spec/Breath in MainTex.a and Opacity in TypeMask.r
  const isV2ShaderFamily =
    effectiveShaderKind !== 'Face' &&
    effectiveShaderKind !== 'Eye' &&
    !emCfg.isEffectVfx &&
    !isStarDecal &&
    (parentNameL.includes('charv2') ||
      pickSwitch(
        slot,
        [
          'UVSwitchCharacterMode',
          'UseRegionID',
          'UseBlendParameter',
          'UseRampIDMask',
          'UseOnlySkinRampColor',
          'UseHueShift',
          'UseBlurTranslucentGlass'
        ],
        false
      ));
  const isV2Opacity = isV2ShaderFamily && hasFtm;

  const isMixedSkinSlot =
    effectiveShaderKind !== 'Hair' &&
    effectiveShaderKind !== 'Eye' &&
    !hasSheerToken &&
    !useBlurGlass &&
    (hasSkinWet || hasMixedBodyToken);

  const skinMin = pickScalar(slot, ['SkinMin'], -1.0);
  const skinMax = pickScalar(slot, ['SkinMax'], skinMin);
  const transClothMin = pickScalar(slot, ['TransClothMin'], -1.0);
  const transClothMax = pickScalar(slot, ['TransClothMax'], transClothMin);
  const hasTransClothRange = useTranslucentCloth && transClothMin >= 0.0 && transClothMax >= transClothMin;
  const waterClothMin = pickScalar(slot, ['WaterClothMin'], -1.0);
  const waterClothMax = pickScalar(slot, ['WaterClothMax'], waterClothMin);
  const hasWaterClothRange = useWaterCloth && waterClothMin >= 0.0 && waterClothMax >= waterClothMin;

  const rawOpInt = pickScalar(slot, ['OpacityIntensity', 'Opacity', 'AlphaScale'], 1.0);
  const opacityIntensity = Math.min(Math.max(rawOpInt, 0.25), 2.0);
  const glassOpacity = pickScalar(slot, ['GlassOpacity', 'DepMaskOpacity'], -1.0);
  const hasGlassHint =
    useBlurGlass ||
    slotNameL.includes('glass') ||
    parentNameL.includes('glass') ||
    glassOpacity >= 0.0;

  let alphaMode: 0 | 1 | 2 | 3 = 0;
  const isHairTranslucent = effectiveShaderKind === 'Hair' && blendTranslucent;
  const translucentDither = pickScalar(slot, ['TranslucentDitherVaule', 'TranslucentDitherValue'], 0.0);
  const hasTranslucentMaskParams = hasScalarKey(slot, ['TranslucentMask_Offset', 'TranslucentMask_Width']);
  const hasVeilSlotName = ['alpha', 'glass', 'tail', 'veil'].some((t) => slotNameL.includes(t));
  const isMaskedSheerVeil = Boolean(
    useTranslucentSwitch &&
    (hasVeilSlotName || useAlphaBlendMode || hasWetOverlayMI || translucentDither > 0.01 || rawOpInt < 0.99 || hasTranslucentMaskParams)
  );
  if (!emCfg.isEffectVfx && !isStarDecal && effectiveShaderKind !== 'Hair' && effectiveShaderKind !== 'Eye' && effectiveShaderKind !== 'Face') {
    if (useWaterCloth || hasBlendWaterMI) {
      alphaMode = 3;
    } else if (useBlurGlass || (blendTranslucent && hasGlassHint)) {
      alphaMode = 2;
    } else if (
      !isMixedSkinSlot &&
      !(useFurCard && !blendTranslucent) &&
      (useTranslucentCloth || blendTranslucent || isMaskedSheerVeil)
    ) {
      alphaMode = 1;
    }
  }

  // Mixed Up/Down/Body slots can still carry wet-alpha / translucent / BlendWater / TransCloth cloth regions while protecting Skin RGID
  const isMixedSkinFade =
    isMixedSkinSlot &&
    !emCfg.isEffectVfx &&
    !isStarDecal &&
    effectiveShaderKind !== 'Face' &&
    (useWaterCloth ||
      hasBlendWaterMI ||
      useTranslucentCloth ||
      blendTranslucent ||
      (hasWetOverlayMI && useWetClipMask));

  const hasWetClipMask = Boolean(hasWetOverlayMI && useWetClipMask);

  let isTransparentMaterial = false;
  let depthWrite = true;
  let useSkinProtect = false;

  if (emCfg.isEffectVfx) {
    isTransparentMaterial = emCfg.vfxTranslucent || emCfg.vfxAdditive;
    depthWrite = !isTransparentMaterial;
  } else if (isHairTranslucent) {
    isTransparentMaterial = true;
    depthWrite = true;
  } else if (isMixedSkinSlot) {
    isTransparentMaterial = isMixedSkinFade || alphaMode !== 0;
    depthWrite = true;
    useSkinProtect = isTransparentMaterial;
  } else {
    isTransparentMaterial = alphaMode !== 0;
    depthWrite = alphaMode === 0 || useFurCard;
  }

  const useGlslCutout = !emCfg.isEffectVfx && (alphaMode !== 0 || isMixedSkinFade || isHairTranslucent);
  // On CharV2 (M_CharV2_Com), MaskMode == 0 (!UseTranslucent && !UseAlphaBlendMode) returns OpacityMask = 1.0 without clipping.
  const v2MaskMode = isV2Opacity ? (useTranslucentSwitch ? 1 : useAlphaBlendMode ? 2 : 0) : -1;
  const shouldMaskedClip =
    !emCfg.isEffectVfx &&
    !useGlslCutout &&
    isMasked &&
    (!isV2Opacity || v2MaskMode !== 0 || useFurCard || useWaterCloth || hasBlendWaterMI || useWetClipMask);
  const effectiveAlphaClip = isV2Opacity && alphaClip === 0.35 ? 0.3333 : alphaClip;
  const alphaTest = shouldMaskedClip ? effectiveAlphaClip : 0.0;

  const isOutlineOrProxy =
    slot?.shaderType === 'Outline' ||
    slot?.shaderType === 'FaceShadow' ||
    slot?.shaderType === 'Distortion' ||
    slotNameL.endsWith('_ol') ||
    slotNameL.includes('ol_');

  const wetCapable = Boolean(
    !emCfg.isEffectVfx &&
    !isStarDecal &&
    !isOutlineOrProxy &&
    effectiveShaderKind !== 'Eye' &&
    (useCharWet || hasWetOverlayMI || hasSkinWet || hasFtm || useWaterCloth || hasBlendWaterMI)
  );

  // Only genuine wet-alpha / translucent / glass / water-cloth / wet-clip-mask slots get alpha change!
  // Opaque clothes & skin-only slots keep wetAlphaCapable = 0.0 (request: not all characters have wet-alpha).
  let wetAlphaCapable = 0.0;
  if (
    !emCfg.isEffectVfx &&
    !isStarDecal &&
    !isOutlineOrProxy &&
    !(useFurCard && !blendTranslucent) &&
    effectiveShaderKind !== 'Hair' &&
    effectiveShaderKind !== 'Face' &&
    effectiveShaderKind !== 'Eye'
  ) {
    if (alphaMode === 3 || hasBlendWaterMI || useWaterCloth) {
      wetAlphaCapable = 1.0;
    } else if (hasWetOverlayMI && (useWetClipMask || useTranslucentSwitch || useTranslucentCloth || alphaMode > 0)) {
      wetAlphaCapable = 0.95;
    } else if (alphaMode === 2 || alphaMode === 1 || isMixedSkinFade) {
      wetAlphaCapable = 0.88;
    }
  }

  const wetMorningInt = pickScalar(
    slot,
    ['WetMI_CharWetIntensity_Morning', 'CharWetIntensity_Morning', 'WetMI_WetDarkenIntensity', 'WetDarkenIntensity'],
    -1
  );
  let wetDarkenStrength = 0.24;
  if (effectiveShaderKind === 'Face' || (hasSkinWet && !useTranslucentCloth && alphaMode === 0 && !isMixedSkinFade)) {
    wetDarkenStrength = hasWetOverlayMI ? 0.14 : 0.10;
  } else if (effectiveShaderKind === 'Hair') {
    wetDarkenStrength = 0.18;
  } else if (hasWetOverlayMI) {
    wetDarkenStrength = wetMorningInt > 0 ? Math.min(0.28 + wetMorningInt * 0.05, 0.42) : 0.34;
  }

  const wetRoughnessMin =
    effectiveShaderKind === 'Face' || hasSkinWet
      ? 0.24
      : effectiveShaderKind === 'Hair'
        ? 0.22
        : 0.12;

  const pickLinRgb = (names: string[], fallback: [number, number, number, number]) => {
    const v = pickNonZeroVec(slot, names, fallback);
    return new THREE.Vector3(Math.min(Math.max(v[0], 0), 2), Math.min(Math.max(v[1], 0), 2), Math.min(Math.max(v[2], 0), 2));
  };

  return {
    alphaMode,
    isTransparentMaterial,
    depthWrite,
    alphaTest,
    isV2Opacity,
    v2MaskMode,
    useSkinProtect,
    useGlslCutout,
    isMixedSkinSlot,
    isHairTranslucent,
    hasWetClipMask,
    useTranslucentCloth,
    opacityIntensity,
    glassOpacity,
    skinMin,
    skinMax,
    transClothMin,
    transClothMax,
    hasTransClothRange,
    waterClothMin,
    waterClothMax,
    hasWaterClothRange,
    hasWetOverlayMI,
    hasBlendWaterMI,
    wetCapable,
    wetAlphaCapable,
    wetDarkenStrength,
    wetRoughnessMin,
    useStocking,
    useFurCard,
    furAlphaIntensity,
    wcEdgeColor1: pickLinRgb(['WC_EdgeColor1'], [0.97, 0.89, 0.65, 1.0]),
    wcEdgeColor2: pickLinRgb(['WC_EdgeColor2'], [0.14, 1.0, 0.83, 1.0]),
    wcEdgeColor3: pickLinRgb(['WC_EdgeColor3'], [0.0, 0.63, 1.0, 1.0]),
    wcRefractColor: pickLinRgb(['WC_RefractColor'], [0.0, 0.84, 0.89, 1.0])
  };
}

export interface ManifestWetAlphaSummary {
  hasWetOverlayMI: boolean;
  hasBlendWater: boolean;
  hasWaterCloth: boolean;
  translucentSlots: number;
  wetAlphaSlotCount: number;
  wetCapableCount: number;
}

function inspectSlotAlphaWet(slot: MaterialSlotDto | undefined): WuWaAlphaWetConfig | null {
  if (!slot || slot.shaderType === 'Outline' || slot.shaderType === 'FaceShadow' || slot.shaderType === 'Distortion') {
    return null;
  }
  const isStarDecal = Boolean(slot.name.includes('Star') || slot.parentName?.includes('XinHen'));
  const isMasked = Boolean(slot.blendMode?.includes('Masked')) || pickSwitch(slot, ['bAlphaTest', 'UseAlphaTest', 'EnableAlpha'], false);
  const hasMain = Boolean(pickTex(slot, ['MainTex', 'BaseColor', 'Diffuse', 'Albedo', 'ColorMap', 'D', 'Base']));
  const hasFtm =
    hasTexKeyContaining(slot, '_ftm') ||
    Object.values(slot.textures ?? {}).some((v) => v.toLowerCase().includes('_ftm'));
  const hasFurTex = Boolean(isRealTexPath(pickTex(slot, ['Fur_Tex', 'FurTex', 'FurMask'])));
  const emCfg = resolveWuWaEmissiveConfig(slot, slot.shaderType, null, null, false, false, false, false, false);
  return resolveWuWaAlphaAndWetConfig(slot, slot.shaderType, emCfg, hasFtm, hasMain, isStarDecal, isMasked, 0.35, hasFurTex);
}

export function getSlotWetAlphaTags(slot: MaterialSlotDto | undefined): string[] {
  const aw = inspectSlotAlphaWet(slot);
  if (!aw) return [];
  const tags: string[] = [];
  if (aw.useFurCard) tags.push('FurCard');
  if (aw.hasWetOverlayMI) tags.push('WetMI');
  if (aw.alphaMode === 3) tags.push('WaterCloth');
  else if (aw.hasBlendWaterMI) tags.push('BlendWater');
  if (aw.alphaMode === 2) tags.push('Glass');
  else if (aw.alphaMode === 1 || aw.useTranslucentCloth) tags.push('Translucent');
  if (aw.hasWetClipMask) tags.push('WetClip');
  if (aw.wetAlphaCapable > 0.01) tags.push('WetAlpha');
  if (aw.useSkinProtect) tags.push('SkinSafe');
  return tags;
}

export function summarizeManifestWetAlpha(slots: MaterialSlotDto[] | undefined): ManifestWetAlphaSummary {
  let hasWetOverlayMI = false;
  let hasBlendWater = false;
  let hasWaterCloth = false;
  let translucentSlots = 0;
  let wetAlphaSlotCount = 0;
  let wetCapableCount = 0;

  if (!slots) {
    return { hasWetOverlayMI, hasBlendWater, hasWaterCloth, translucentSlots, wetAlphaSlotCount, wetCapableCount };
  }

  for (const slot of slots) {
    const aw = inspectSlotAlphaWet(slot);
    if (!aw) continue;

    if (aw.hasWetOverlayMI) hasWetOverlayMI = true;
    if (aw.hasBlendWaterMI) hasBlendWater = true;
    if (aw.alphaMode === 3) hasWaterCloth = true;
    if (aw.alphaMode === 1 || aw.alphaMode === 2 || aw.alphaMode === 3 || aw.useTranslucentCloth) translucentSlots++;
    if (aw.wetAlphaCapable > 0.01) wetAlphaSlotCount++;
    if (aw.wetCapable) wetCapableCount++;
  }

  return { hasWetOverlayMI, hasBlendWater, hasWaterCloth, translucentSlots, wetAlphaSlotCount, wetCapableCount };
}

function wuWaAlphaWetUniformDecls(): string {
  return `
    uniform float uWetness;
    uniform float uWetAlpha;
    uniform sampler2D uWcDissolveTex;
    uniform sampler2D uWcCausticsTex;
    uniform sampler2D uRgidTex;
    uniform float uHasWcDissolve;
    uniform float uHasWcCaustics;
    uniform float uHasRgid;
    uniform float uSkinMin;
    uniform float uSkinMax;
    uniform float uHasTransClothRange;
    uniform float uTransClothMin;
    uniform float uTransClothMax;
    uniform float uHasWaterClothRange;
    uniform float uWaterClothMin;
    uniform float uWaterClothMax;
    uniform float uHasWetClipMask;
    uniform float uHasBlendWaterMI;
    uniform float uGlassOpacity;
    uniform float uAlphaMode;
    uniform float uSkinProtect;
    uniform float uHairTranslucent;
    uniform float uOpacityIntensity;
    uniform float uWetCapable;
    uniform float uWetAlphaCapable;
    uniform float uWetDarkenStrength;
    uniform float uWetRoughnessMin;
    uniform float uUseStocking;
    uniform sampler2D uFurTex;
    uniform float uFurAlphaInt;
    uniform float uFurAlphaClip;
    uniform vec3 uWcEdgeColor1;
    uniform vec3 uWcEdgeColor2;
    uniform vec3 uWcEdgeColor3;
    uniform vec3 uWcRefractColor;`;
}

function applyWuWaAlphaWetUniforms(
  uniforms: Record<string, THREE.IUniform>,
  shared: ToonRuntimeUniforms,
  aw: WuWaAlphaWetConfig,
  wcDissolveTex: THREE.Texture | null,
  wcCausticsTex: THREE.Texture | null,
  rgidTex: THREE.Texture | null,
  furTex: THREE.Texture | null = null
) {
  uniforms.uWetness = shared.uWetness;
  uniforms.uWetAlpha = shared.uWetAlpha;
  uniforms.uWcDissolveTex = { value: wcDissolveTex ?? texCache.white };
  uniforms.uWcCausticsTex = { value: wcCausticsTex ?? texCache.black };
  uniforms.uRgidTex = { value: rgidTex ?? texCache.black };
  uniforms.uHasWcDissolve = { value: wcDissolveTex ? 1.0 : 0.0 };
  uniforms.uHasWcCaustics = { value: wcCausticsTex ? 1.0 : 0.0 };
  uniforms.uHasRgid = { value: rgidTex ? 1.0 : 0.0 };
  uniforms.uSkinMin = { value: aw.skinMin };
  uniforms.uSkinMax = { value: aw.skinMax };
  uniforms.uHasTransClothRange = { value: aw.hasTransClothRange ? 1.0 : 0.0 };
  uniforms.uTransClothMin = { value: aw.transClothMin };
  uniforms.uTransClothMax = { value: aw.transClothMax };
  uniforms.uHasWaterClothRange = { value: aw.hasWaterClothRange ? 1.0 : 0.0 };
  uniforms.uWaterClothMin = { value: aw.waterClothMin };
  uniforms.uWaterClothMax = { value: aw.waterClothMax };
  uniforms.uHasWetClipMask = { value: aw.hasWetClipMask ? 1.0 : 0.0 };
  uniforms.uHasBlendWaterMI = { value: aw.hasBlendWaterMI ? 1.0 : 0.0 };
  uniforms.uGlassOpacity = { value: aw.glassOpacity };
  uniforms.uAlphaMode = { value: aw.alphaMode };
  uniforms.uSkinProtect = { value: aw.useSkinProtect ? 1.0 : 0.0 };
  uniforms.uHairTranslucent = { value: aw.isHairTranslucent ? 1.0 : 0.0 };
  uniforms.uOpacityIntensity = { value: aw.opacityIntensity };
  uniforms.uWetCapable = { value: aw.wetCapable ? 1.0 : 0.0 };
  uniforms.uWetAlphaCapable = { value: aw.wetAlphaCapable };
  uniforms.uWetDarkenStrength = { value: aw.wetDarkenStrength };
  uniforms.uWetRoughnessMin = { value: aw.wetRoughnessMin };
  uniforms.uUseStocking = { value: aw.useStocking ? 1.0 : 0.0 };
  uniforms.uFurTex = { value: furTex ?? texCache.white };
  uniforms.uFurAlphaInt = { value: aw.furAlphaIntensity };
  uniforms.uFurAlphaClip = { value: Math.min(Math.max(aw.alphaTest > 0 ? Math.min(aw.alphaTest * 0.72, 0.28) : 0.24, 0.16), 0.32) };
  uniforms.uWcEdgeColor1 = { value: aw.wcEdgeColor1 };
  uniforms.uWcEdgeColor2 = { value: aw.wcEdgeColor2 };
  uniforms.uWcEdgeColor3 = { value: aw.wcEdgeColor3 };
  uniforms.uWcRefractColor = { value: aw.wcRefractColor };
}

function wuWaEvaluateAlphaGlsl(
  baseSampleVar: string,
  uvExpr: string,
  ndvExpr: string,
  outAlphaVar: string,
  outWaterTintVar: string,
  outWaterEmitVar: string,
  useTypeMaskAlpha = false
): string {
  return `
    float wuSrcAlpha = ${useTypeMaskAlpha ? `texture2D(uIdTex, ${uvExpr}).r` : `${baseSampleVar}.a`};
    float ${outAlphaVar} = ${useTypeMaskAlpha ? `clamp(wuSrcAlpha * uOpacityIntensity, 0.0, 1.0)` : `${baseSampleVar}.a`};
    vec3 ${outWaterTintVar} = vec3(0.0);
    vec3 ${outWaterEmitVar} = vec3(0.0);
    float wuWetAlpFactor = clamp(uWetness * uWetAlpha * uWetAlphaCapable, 0.0, 1.0);
    float wuRgid = uHasRgid > 0.5 ? floor(texture2D(uRgidTex, ${uvExpr}).r * 255.0 + 0.5) : -1.0;
    bool wuIsSkinRgid = (uHasRgid > 0.5 && uSkinMin >= -0.5 && wuRgid >= uSkinMin - 0.3 && wuRgid <= uSkinMax + 0.3);
    bool wuIsTransClothRgid = (uHasRgid > 0.5 && uHasTransClothRange > 0.5 && wuRgid >= uTransClothMin - 0.3 && wuRgid <= uTransClothMax + 0.3);
    bool wuIsWaterClothRgid = (uHasRgid > 0.5 && uHasWaterClothRange > 0.5 && wuRgid >= uWaterClothMin - 0.3 && wuRgid <= uWaterClothMax + 0.3);

    if (uHairTranslucent > 0.5) {
      if (wuSrcAlpha <= 0.025) discard;
      ${outAlphaVar} = wuSrcAlpha >= 0.42 ? 1.0 : smoothstep(0.025, 0.42, wuSrcAlpha);
    } else if (uAlphaMode >= 2.5) {
      float rawA = wuSrcAlpha;
      if (wuIsSkinRgid) {
        ${outAlphaVar} = 1.0;
      } else {
        if (rawA <= 0.025) discard;
        vec4 wcD = uHasWcDissolve > 0.5
          ? texture2D(uWcDissolveTex, ${uvExpr})
          : vec4(
              uSkinProtect > 0.5
                ? (1.0 - smoothstep(0.28, 0.37, rawA))
                : mix(0.85, 1.0 - smoothstep(0.55, 0.98, rawA), 0.35),
              0.0,
              0.5,
              1.0
            );
        float sdfMask = smoothstep(0.06, 0.34, max(wcD.r, wcD.g * 0.75));
        bool hasWaterZoneMask = (uHasRgid > 0.5 && uHasWaterClothRange > 0.5);
        bool waterClothPixel = hasWaterZoneMask ? (wuIsWaterClothRgid || rawA < 0.37) : false;
        if ((hasWaterZoneMask && !waterClothPixel)
            || (!hasWaterZoneMask && uSkinProtect > 0.5 && rawA >= 0.37 && sdfMask < 0.15)) {
          ${outAlphaVar} = 1.0;
        } else {
          float zoneMask = (hasWaterZoneMask && wuIsWaterClothRgid)
            ? max(sdfMask, 0.65)
            : sdfMask;
          float dryAlpha = rawA < 0.37
            ? clamp(pow(clamp(rawA / 0.36, 0.06, 1.0), 0.70) * 0.85 * uOpacityIntensity, 0.35, 0.92)
            : clamp(mix(0.88, clamp(0.52 + 0.40 * rawA, 0.45, 0.92), zoneMask) * uOpacityIntensity, 0.42, 0.96);
          float wetTarget = clamp(dryAlpha * mix(0.32, 0.48, clamp(wcD.b, 0.0, 1.0)), 0.14, 0.42);
          float fadeWeight = (uHasRgid > 0.5 && wuIsWaterClothRgid) ? 1.0 : clamp(0.35 + 0.65 * zoneMask, 0.0, 1.0);
          ${outAlphaVar} = clamp(mix(dryAlpha, wetTarget, wuWetAlpFactor * fadeWeight), 0.12, 1.0);

          // Steady moisture tint & soft meniscus edge (no animated waves/ripples)
          float dissolveCut = 0.14 + 0.52 * wuWetAlpFactor;
          float wcCoord = clamp(wcD.r * 0.75 + wcD.b * 0.35, 0.0, 1.0);
          float waterBand = (1.0 - smoothstep(0.0, 0.18, abs(wcCoord - dissolveCut))) * zoneMask;
          vec3 edgeFoam = mix(uWcEdgeColor1, uWcEdgeColor2, clamp(zoneMask, 0.0, 1.0));
          edgeFoam = mix(edgeFoam, uWcEdgeColor3, clamp(1.0 - ${ndvExpr}, 0.0, 1.0));
          float waterActive = clamp(uWetness * 0.75 + uWetAlpha * 0.25, 0.0, 1.0);
          ${outWaterTintVar} = uWcRefractColor * (0.12 + 0.20 * waterActive) * zoneMask;
          ${outWaterEmitVar} = edgeFoam * waterBand * (0.18 + 0.36 * waterActive) * wuWetAlpFactor;
        }
      }
    } else if (uSkinProtect > 0.5) {
      float rawA = wuSrcAlpha;
      if (wuIsSkinRgid) {
        // Protected bare skin (matched via RegionIDTex [SkinMin..SkinMax]) stays 100% opaque
        ${outAlphaVar} = 1.0;
      } else if (rawA <= 0.025) {
        discard;
      } else if (wuIsTransClothRgid) {
        // Translucent cloth sub-region on mixed mesh (e.g. LinNai Base Up RGID=1) fades cleanly when wet
        float tcDry = clamp(mix(0.68, 0.88, clamp(rawA, 0.0, 1.0)) * uOpacityIntensity, 0.45, 0.92);
        float tcWet = clamp(tcDry * 0.25, 0.14, 0.30);
        ${outAlphaVar} = mix(tcDry, tcWet, wuWetAlpFactor);
      } else if (rawA >= 0.37) {
        ${outAlphaVar} = 1.0;
      } else {
        float trimDry = clamp(pow(clamp(rawA / 0.36, 0.05, 1.0), 0.70) * 0.82 * uOpacityIntensity, 0.14, 0.88);
        float trimWet = clamp(trimDry * 0.28, 0.08, 0.30);
        ${outAlphaVar} = mix(trimDry, trimWet, wuWetAlpFactor);
      }
    } else if (uAlphaMode > 0.5 && uAlphaMode < 1.5) {
      float rawA = wuSrcAlpha;
      if (rawA <= 0.025) discard;
      float sheerDry = (rawA >= 0.96 && uOpacityIntensity >= 0.99)
        ? 1.0
        : clamp(pow(clamp(rawA, 0.0, 1.0), 0.62) * 0.90 * uOpacityIntensity, 0.16, 0.92);
      float sheerWet = clamp(sheerDry * 0.26, 0.10, 0.30);
      ${outAlphaVar} = mix(sheerDry, sheerWet, wuWetAlpFactor);
    } else if (uAlphaMode >= 1.5 && uAlphaMode < 2.5) {
      float rawA = wuSrcAlpha;
      if (rawA <= 0.025) discard;
      float glassFresnel = pow(1.0 - clamp(${ndvExpr}, 0.0, 1.0), 1.55);
      float glassBaseOp = uGlassOpacity >= 0.0 ? clamp(uGlassOpacity, 0.28, 0.82) : 0.44;
      float frostDry = clamp(mix(glassBaseOp, 0.88, glassFresnel) * clamp(rawA * 0.55 + 0.55, 0.38, 1.05), 0.24, 0.90);
      float frostWet = clamp(frostDry * 0.27, 0.10, 0.28);
      ${outAlphaVar} = mix(frostDry, frostWet, wuWetAlpFactor);
    } else if (${useTypeMaskAlpha ? 'true' : 'false'}) {
      if (wuIsSkinRgid) {
        ${outAlphaVar} = 1.0;
      }
    }`;
}

function wuWaWetSurfaceGlsl(
  _uvExpr: string,
  _worldPosExpr: string,
  worldNormalExpr: string,
  viewDirExpr: string,
  matMetallicExpr: string,
  porosityWeightExpr: string,
  outDarkenVar: string,
  outWetSpecBoostVar: string
): string {
  return `
    float ${outDarkenVar} = 1.0;
    vec3 ${outWetSpecBoostVar} = vec3(0.0);
    float wuWetAmt = clamp(uWetness, 0.0, 1.0) * step(0.5, uWetCapable);
    if (wuWetAmt > 0.002) {
      vec3 wuWn = normalize(${worldNormalExpr});
      float wuNdv = clamp(dot(wuWn, normalize(${viewDirExpr})), 0.0, 1.0);

      // Smooth, steady wet darkening without temporal wave/ripple or streak noise
      float metalDamp = mix(1.0, 0.55, clamp(${matMetallicExpr}, 0.0, 1.0));
      ${outDarkenVar} = 1.0 - (uWetDarkenStrength * metalDamp * wuWetAmt * ${porosityWeightExpr});

      // Clean Fresnel wet clearcoat sheen
      float wetFresnel = pow(1.0 - wuNdv, 3.1);
      float wetFilm = wetFresnel * 0.28 * wuWetAmt;
      ${outWetSpecBoostVar} = vec3(0.90, 0.95, 1.0) * wetFilm;
      if (uUseStocking > 0.5) {
        ${outWetSpecBoostVar} += vec3(0.10, 0.07, 0.06) * wetFresnel * wuWetAmt;
      }
    }`;
}

export async function createWuWaMaterialForSection(
  mesh: THREE.Mesh,
  slot: MaterialSlotDto | undefined,
  outlineSlot: MaterialSlotDto | undefined,
  mode: ShaderRenderMode,
  shared: ToonRuntimeUniforms
): Promise<{ mainMat: THREE.Material; outlineMat: THREE.Material | null }> {
  const geom = mesh.geometry;
  const hasVColor = Boolean(geom.getAttribute('color'));
  const hasUv1 = Boolean(geom.getAttribute('uv1'));
  const hasUv2 = Boolean(geom.getAttribute('uv2'));
  const hasNormal = Boolean(geom.getAttribute('normal'));

  const mainPath = pickTex(slot, ['MainTex', 'BaseColor', 'Diffuse', 'Albedo', 'ColorMap', 'D', 'Base']);
  const maskPath = pickTex(slot, ['MaskTex', 'Mask', 'MMap', 'HM', 'SDF']);
  const idRawPath = pickTex(slot, ['TypeMask', 'IDTex', 'IDMap', 'RampMask', 'SwitchTex', 'ID']);
  const idPath = isRealTexPath(idRawPath) ? idRawPath : undefined;
  const normalPath = pickTex(slot, ['Normal_Roughness_Metallic', 'NormalMap', 'Normal']);
  const hasPackedNRM = hasTexKeyContaining(slot, 'normal_roughness_metallic') || Boolean(normalPath?.toLowerCase().endsWith('_n'));
  const rampPath = pickTex(slot, ['Ramp', 'RampTex', 'SkinRamp']);
  const emPath = pickTex(slot, ['EM', 'EmTex', 'EmissiveMap', 'Emissive']);
  const secondRaw = pickTex(slot, ['Second_RGB', 'Second']);
  const noiseMaskRaw = pickTex(slot, ['R_Noise_A_Mask']);
  const commonNoiseRaw = pickTex(slot, ['CommonNoiseMap']);
  const wcDissolveRaw = pickTex(slot, ['WC_DissolveAndSDFTex', 'DissolveAndSDFTex']);
  const wcCausticsRaw = pickTex(slot, ['WC_CausticsTex', 'CausticsTex']);
  const rgidRaw = pickTex(slot, ['RegionIDTex', 'RegionIdTex', 'RegionID']);
  const furRaw = pickTex(slot, ['Fur_Tex', 'FurTex', 'FurMask']);

  const secondPath = isRealTexPath(secondRaw) ? secondRaw : undefined;
  const noiseMaskPath = isRealTexPath(noiseMaskRaw) ? noiseMaskRaw : undefined;
  const commonNoisePath = isRealTexPath(commonNoiseRaw) ? commonNoiseRaw : undefined;
  const wcDissolvePath = isRealTexPath(wcDissolveRaw) ? wcDissolveRaw : undefined;
  const wcCausticsPath = isRealTexPath(wcCausticsRaw) ? wcCausticsRaw : undefined;
  const rgidPath = isRealTexPath(rgidRaw) ? rgidRaw : undefined;
  const furPath = isRealTexPath(furRaw) ? furRaw : undefined;

  const isEyeSlot = slot?.shaderType === 'Eye';
  const [mainTex, maskTex, idTex, normalTex, rampTex, emTex, secondTex, noiseMaskTex, commonNoiseTex, wcDissolveTex, wcCausticsTex, rgidTex, furTex] = await Promise.all([
    texCache.load(mainPath, true),
    texCache.load(maskPath, false),
    texCache.load(idPath, false),
    texCache.load(normalPath, false),
    texCache.load(rampPath, true, true),
    texCache.load(emPath, !isEyeSlot),
    texCache.load(secondPath, true),
    texCache.load(noiseMaskPath, false),
    texCache.load(commonNoisePath, false),
    texCache.load(wcDissolvePath, false),
    texCache.load(wcCausticsPath, false),
    texCache.load(rgidPath, false, false, true),
    texCache.load(furPath, false, true)
  ]);

  const isStarDecal = Boolean(slot?.name.includes('Star') || slot?.parentName?.includes('XinHen'));
  const isMasked = isStarDecal || Boolean(slot?.blendMode?.includes('Masked')) ||
    pickSwitch(slot, ['bAlphaTest', 'UseAlphaTest', 'EnableAlpha'], false);
  const alphaClip = isStarDecal ? 0.55 : pickScalar(slot, ['OpacityMaskClipValue', 'AlphaClip'], 0.35);

  const shaderKind = slot?.shaderType ?? 'Body';
  const isFireMat = Boolean(
    (slot?.name?.toLowerCase().includes('fire') || slot?.parentName?.toLowerCase().includes('fire')) &&
    !slot?.name?.toLowerCase().includes('face')
  );
  const isWeapon = Boolean(slot?.assetPath?.includes('/Weapon/') || slot?.parentName?.toLowerCase().includes('_wp'));
  const emCfg = resolveWuWaEmissiveConfig(
    slot,
    shaderKind,
    mainTex,
    emTex,
    Boolean(noiseMaskTex),
    Boolean(secondTex),
    Boolean(commonNoiseTex),
    isFireMat,
    isWeapon
  );
  const effectiveShaderKind = emCfg.isEffectVfx ? 'Standard' : shaderKind;
  const hasFtm =
    hasTexKeyContaining(slot, '_ftm') ||
    Object.values(slot?.textures ?? {}).some((v) => v.toLowerCase().includes('_ftm'));
  const awCfg = resolveWuWaAlphaAndWetConfig(
    slot,
    effectiveShaderKind,
    emCfg,
    hasFtm,
    Boolean(mainTex),
    isStarDecal,
    isMasked,
    alphaClip,
    Boolean(furTex)
  );

  if (mode === 'wireframe') {
    return {
      mainMat: new THREE.MeshBasicMaterial({
        color: '#38bdf8',
        wireframe: true
      }),
      outlineMat: null
    };
  }

  if (mode === 'flat-albedo') {
    return {
      mainMat: new THREE.MeshBasicMaterial({
        map: mainTex ?? texCache.white,
        side: (slot?.twoSided || effectiveShaderKind === 'Hair' || emCfg.isEffectVfx) ? THREE.DoubleSide : THREE.FrontSide,
        transparent: awCfg.isTransparentMaterial,
        blending: emCfg.vfxAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: awCfg.depthWrite,
        alphaTest: awCfg.alphaTest
      }),
      outlineMat: null
    };
  }

  const applyWuWaEmissiveUniforms = (
    uniforms: Record<string, THREE.IUniform>,
    includeBaseTex: boolean
  ) => {
    if (includeBaseTex) {
      uniforms.uMainTex = { value: mainTex ?? texCache.white };
      uniforms.uMaskTex = { value: maskTex ?? texCache.white };
      uniforms.uIdTex = { value: idTex ?? texCache.black };
      uniforms.uEmTex = { value: emTex ?? texCache.black };
    }
    uniforms.uSecondTex = { value: secondTex ?? texCache.black };
    uniforms.uNoiseMaskTex = { value: noiseMaskTex ?? texCache.black };
    uniforms.uCommonNoiseTex = { value: commonNoiseTex ?? texCache.black };
    uniforms.uEmColor = { value: emCfg.emColor };
    uniforms.uEmStrength = { value: emCfg.emStrength };
    uniforms.uUseAlphaEmission = { value: emCfg.useAlphaEmission ? 1.0 : 0.0 };
    uniforms.uEmThreshold = { value: emCfg.emThreshold };
    // Card-fin Fur slots inherit Cloth's UseEffectMaterial + R_Noise_A_Mask while setting COLOR_0.A = 0; never apply EffectGlow on fur cards.
    uniforms.uUseEffectGlow = { value: (emCfg.useEffectGlow && !awCfg.useFurCard) ? 1.0 : 0.0 };
    uniforms.uSecondGlowColor = { value: emCfg.secondGlowColor };
    uniforms.uUseStarrySky = { value: emCfg.useStarrySky ? 1.0 : 0.0 };
    uniforms.uStarryColor = { value: emCfg.starryColor };
    uniforms.uEyeDiffColors = { value: emCfg.eyeDiffColors };
    uniforms.uEyeEmInt = { value: emCfg.eyeEmInt };
    uniforms.uEyeGlowColor = { value: emCfg.eyeGlowColor };
    uniforms.uAniShapeColor = { value: emCfg.aniShapeColor };
    uniforms.uVfxTint = { value: emCfg.vfxTint };
    uniforms.uVfxAlphaClip = { value: isMasked ? alphaClip : 0.02 };
  };

  if (mode === 'pbr') {
    const pbr = new THREE.MeshStandardMaterial({
      map: mainTex ?? texCache.white,
      normalMap: hasPackedNRM ? null : (normalTex ?? null),
      roughness: pickScalar(slot, ['Roughness', 'RoughnessScale'], 0.68),
      metalness: pickScalar(slot, ['Metallic', 'MetallicScale'], 0.04),
      side: (slot?.twoSided || effectiveShaderKind === 'Hair' || emCfg.isEffectVfx) ? THREE.DoubleSide : THREE.FrontSide,
      transparent: awCfg.isTransparentMaterial,
      blending: emCfg.vfxAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: awCfg.depthWrite,
      alphaTest: awCfg.alphaTest
    });
    pbr.defines = pbr.defines ?? {};
    pbr.defines.USE_UV = '';
    if (hasUv2) pbr.defines.HAS_WUWA_UV2 = 1;
    if (awCfg.useFurCard && furTex) pbr.defines.HAS_WUWA_FUR = 1;
    if (hasPackedNRM && normalTex) pbr.defines.HAS_WUWA_PACKED_NRM = 1;
    if (maskTex) pbr.defines.HAS_MASK_TEX = 1;
    if (idTex) pbr.defines.HAS_ID_TEX = 1;
    if (emTex) pbr.defines.HAS_EM_TEX = 1;
    if (secondTex) pbr.defines.HAS_SECOND_TEX = 1;
    if (noiseMaskTex) pbr.defines.HAS_NOISE_MASK_TEX = 1;
    if (commonNoiseTex) pbr.defines.HAS_COMMON_NOISE_TEX = 1;
    if (emCfg.isEffectVfx) pbr.defines.IS_EFFECT_VFX = 1;
    if (emCfg.useEyeEm) pbr.defines.IS_WUWA_EYE = 1;

    pbr.onBeforeCompile = (shader) => {
      shader.uniforms.uWuPackedNrm = { value: normalTex ?? texCache.flatNormal };
      applyWuWaEmissiveUniforms(shader.uniforms, true);
      applyWuWaAlphaWetUniforms(shader.uniforms, shared, awCfg, wcDissolveTex, wcCausticsTex, rgidTex, furTex);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vWuPbrUv;
          varying vec3 vWuPbrWorldPos;
          varying vec3 vWuPbrWorldNormal;
          #if defined(HAS_WUWA_UV2) && !defined(USE_UV2)
            attribute vec2 uv2;
          #endif
          #ifdef HAS_WUWA_UV2
            varying vec2 vWuPbrUv2;
          #endif`
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
          vWuPbrUv = uv;
          #ifdef HAS_WUWA_UV2
            vWuPbrUv2 = uv2;
          #endif`
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vec4 wuPbrWp = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            wuPbrWp = instanceMatrix * wuPbrWp;
          #endif
          wuPbrWp = modelMatrix * wuPbrWp;
          vWuPbrWorldPos = wuPbrWp.xyz;
          #ifndef FLAT_SHADED
            vWuPbrWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
          #else
            vWuPbrWorldNormal = vec3(0.0, 1.0, 0.0);
          #endif`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D uWuPackedNrm;
          uniform sampler2D uMainTex;
          uniform sampler2D uMaskTex;
          uniform sampler2D uIdTex;
          uniform sampler2D uEmTex;
          ${wuWaEmissiveUniformDecls()}
          ${wuWaAlphaWetUniformDecls()}
          varying vec2 vWuPbrUv;
          varying vec3 vWuPbrWorldPos;
          varying vec3 vWuPbrWorldNormal;
          #ifdef HAS_WUWA_UV2
            varying vec2 vWuPbrUv2;
          #endif`
        )
        .replace(
          '#include <map_fragment>',
          `vec3 wuPbrWaterEmit = vec3(0.0);
          #ifdef USE_MAP
            vec4 wuMapSample = texture2D(uMainTex, vWuPbrUv);
            #ifdef IS_EFFECT_VFX
              float vfxM = 1.0;
              #ifdef HAS_MASK_TEX
                vec3 mPx = texture2D(uMaskTex, vWuPbrUv).rgb;
                vfxM = clamp(max(mPx.r, dot(mPx, vec3(0.333))), 0.0, 1.0);
              #endif
              float baseLum = dot(wuMapSample.rgb, vec3(0.299, 0.587, 0.114));
              float baseAlp = wuMapSample.a < 0.98 ? wuMapSample.a : baseLum;
              float effAlp = clamp(baseAlp * vfxM, 0.0, 1.0);
              if (effAlp < uVfxAlphaClip) discard;
              diffuseColor.rgb *= wuMapSample.rgb * uVfxTint;
              diffuseColor.a *= effAlp;
            #else
              float wuPbrFurFeather = 1.0;
              #ifdef HAS_WUWA_FUR
                vec2 wuPbrFurUv = vWuPbrUv;
                #ifdef HAS_WUWA_UV2
                  wuPbrFurUv = vWuPbrUv2;
                #endif
                vec3 wuPbrFurPx = texture2D(uFurTex, wuPbrFurUv).rgb;
                float wuPbrFurMask = clamp(max(wuPbrFurPx.r, dot(wuPbrFurPx, vec3(0.3333))) * uFurAlphaInt, 0.0, 1.0);
                if (wuPbrFurMask < uFurAlphaClip) discard;
                wuPbrFurFeather = smoothstep(uFurAlphaClip, min(uFurAlphaClip + 0.30, 0.92), wuPbrFurMask);
              #endif
              diffuseColor *= wuMapSample;
              vec3 wuPbrV = normalize(cameraPosition - vWuPbrWorldPos);
              vec3 wuPbrN = normalize(vWuPbrWorldNormal);
              float wuPbrNdv = abs(dot(wuPbrN, wuPbrV));
              ${wuWaEvaluateAlphaGlsl('wuMapSample', 'vWuPbrUv', 'wuPbrNdv', 'wuPbrAlphaOut', 'wuPbrWaterTint', 'wuPbrWaterEmitCalc', awCfg.isV2Opacity && Boolean(idTex))}
              diffuseColor.a = ${awCfg.isTransparentMaterial ? 'wuPbrAlphaOut * wuPbrFurFeather' : 'wuPbrAlphaOut'};
              wuPbrWaterEmit = wuPbrWaterEmitCalc;
              if (uAlphaMode >= 2.5) {
                diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb + wuPbrWaterTint, 0.45);
              }
              if (uWetCapable > 0.5 && uWetness > 0.002) {
                float pbrWetAmt = clamp(uWetness, 0.0, 1.0);
                diffuseColor.rgb *= (1.0 - uWetDarkenStrength * pbrWetAmt);
              }
            #endif
          #endif`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          #ifdef HAS_WUWA_PACKED_NRM
            vec4 wuNrmVal = texture2D(uWuPackedNrm, vWuPbrUv);
            roughnessFactor = clamp(wuNrmVal.a, 0.14, 0.96);
          #endif
          if (uWetCapable > 0.5 && uWetness > 0.002) {
            roughnessFactor = mix(roughnessFactor, uWetRoughnessMin, clamp(uWetness, 0.0, 1.0) * 0.85);
          }`
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
          #ifdef HAS_WUWA_PACKED_NRM
            metalnessFactor = clamp(texture2D(uWuPackedNrm, vWuPbrUv).b, 0.0, 0.95);
          #endif`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          vec4 pbrBasePx = texture2D(uMainTex, vWuPbrUv);
          #ifdef IS_EFFECT_VFX
            totalEmissiveRadiance += pbrBasePx.rgb * uVfxTint * 0.9;
          #else
            #ifdef IS_WUWA_EYE
              ${wuWaEmissiveComputeGlsl('vWuPbrUv', 'pbrBasePx', 'wuPbrEm', 'true')}
            #else
              ${wuWaEmissiveComputeGlsl('vWuPbrUv', 'pbrBasePx', 'wuPbrEm', 'false')}
            #endif
            ${wuWaWetSurfaceGlsl('vWuPbrUv', 'vWuPbrWorldPos', 'vWuPbrWorldNormal', 'normalize(cameraPosition - vWuPbrWorldPos)', 'metalnessFactor', '1.0', 'wuPbrWetDkUnused', 'wuPbrWetSpecEmit')}
            float wuPbrWetSpecMask = mix(0.28, 1.0, clamp(diffuseColor.a, 0.0, 1.0));
            totalEmissiveRadiance += wuPbrEm + wuPbrWetSpecEmit * 0.48 * wuPbrWetSpecMask + wuPbrWaterEmit;
            #ifdef HAS_WUWA_FUR
              // Thin crossed fur-card quads need soft wrap fill in PBR so perpendicular blades do not form dark grid seams.
              totalEmissiveRadiance += diffuseColor.rgb * 0.42;
            #endif
          #endif`
        );
    };
    pbr.userData.useFurCard = awCfg.useFurCard;
    pbr.customProgramCacheKey = () =>
      `wuwa-pbr-v5-${isMasked ? 1 : 0}-${hasUv2 ? 1 : 0}-${awCfg.useFurCard ? 1 : 0}-${hasPackedNRM ? 1 : 0}-${maskTex ? 1 : 0}-${idTex ? 1 : 0}-${emTex ? 1 : 0}-${secondTex ? 1 : 0}-${noiseMaskTex ? 1 : 0}-${commonNoiseTex ? 1 : 0}-${emCfg.isEffectVfx ? 1 : 0}-${emCfg.useEyeEm ? 1 : 0}-${awCfg.alphaMode}-${awCfg.isTransparentMaterial ? 1 : 0}-${awCfg.useSkinProtect ? 1 : 0}-${wcDissolveTex ? 1 : 0}-${wcCausticsTex ? 1 : 0}-${rgidTex ? 1 : 0}-${awCfg.hasTransClothRange ? 1 : 0}-${awCfg.hasWaterClothRange ? 1 : 0}-${awCfg.hasWetClipMask ? 1 : 0}-${awCfg.wetCapable ? 1 : 0}-${awCfg.isV2Opacity && idTex ? 1 : 0}`;
    return { mainMat: pbr, outlineMat: null };
  }

  // WuWa Toon Shader via MeshBasicMaterial + onBeforeCompile (full skinning + 161+ morphTarget support!)
  const kindInt =
    isStarDecal ? 4 :
    effectiveShaderKind === 'Face' ? 1 :
    effectiveShaderKind === 'Eye' ? 2 :
    effectiveShaderKind === 'Hair' ? 3 : 0;

  const skinTint = pickVec(slot, ['TintColor'], [1, 1, 1, 1]);
  const subsurfaceColor = pickVec(slot, ['SkinSubsurfaceColor', 'SubsurfaceColor'], [0.88, 0.65, 0.56, 1]);
  const shadowColor = pickVec(slot, ['ShadowColor', 'DarkColor', 'FirstShadowColor', 'ExtraShadowColor'], [0.70, 0.68, 0.76, 1]);
  const rimColor = pickVec(slot, ['RimLightColor', 'RimColor'], [1.0, 0.97, 0.94, 0.30]);
  const rampPos = pickScalar(slot, ['RampPosition', 'RampY'], 0.5);
  const rampInt = pickScalar(slot, ['RampInt'], 0.32);
  const shadowProcess = pickScalar(slot, ['ShadowProcess'], effectiveShaderKind === 'Hair' ? 0.68 : 0.55);
  const shadowWidth = pickScalar(slot, ['ShadowWidth'], 0.04);
  const rimWidth = pickScalar(slot, ['RimLightWidth', 'ToonRimWidth', 'RimWidth'], 0.28);
  const shadowThreshold = pickScalar(slot, ['ShadowOffset', 'RampOffset', 'FaceShadowOffset'], 0.0);

  const mainMat = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    vertexColors: hasVColor,
    side: (slot?.twoSided || effectiveShaderKind === 'Hair' || emCfg.isEffectVfx) ? THREE.DoubleSide : THREE.FrontSide,
    transparent: awCfg.isTransparentMaterial,
    blending: emCfg.vfxAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: awCfg.depthWrite,
    alphaTest: awCfg.alphaTest
  });

  mainMat.defines = mainMat.defines ?? {};
  mainMat.defines.USE_UV = '';
  if (hasUv1) mainMat.defines.HAS_WUWA_UV1 = 1;
  if (hasUv2) mainMat.defines.HAS_WUWA_UV2 = 1;
  if (awCfg.useFurCard && furTex) mainMat.defines.HAS_WUWA_FUR = 1;
  if (hasNormal) mainMat.defines.HAS_WUWA_NORMAL = 1;
  if (mainTex) mainMat.defines.HAS_MAIN_TEX = 1;
  if (maskTex) mainMat.defines.HAS_MASK_TEX = 1;
  if (idTex) mainMat.defines.HAS_ID_TEX = 1;
  if (awCfg.isV2Opacity && idTex) mainMat.defines.USE_TYPEMASK_ALPHA = 1;
  if (normalTex) {
    mainMat.defines.HAS_NORMAL_TEX = 1;
    if (hasPackedNRM) mainMat.defines.HAS_PACKED_NRM = 1;
  }
  if (rampTex) mainMat.defines.HAS_RAMP_TEX = 1;
  if (emTex) mainMat.defines.HAS_EM_TEX = 1;
  if (secondTex) mainMat.defines.HAS_SECOND_TEX = 1;
  if (noiseMaskTex) mainMat.defines.HAS_NOISE_MASK_TEX = 1;
  if (commonNoiseTex) mainMat.defines.HAS_COMMON_NOISE_TEX = 1;
  if (emCfg.isEffectVfx) mainMat.defines.IS_EFFECT_VFX = 1;

  mainMat.onBeforeCompile = (shader) => {
    shader.uniforms.uMainTex = { value: mainTex ?? texCache.white };
    shader.uniforms.uMaskTex = { value: maskTex ?? texCache.white };
    shader.uniforms.uIdTex = { value: idTex ?? texCache.black };
    shader.uniforms.uNormalTex = { value: normalTex ?? texCache.flatNormal };
    shader.uniforms.uRampTex = { value: rampTex ?? texCache.white };
    shader.uniforms.uEmTex = { value: emTex ?? texCache.black };
    applyWuWaEmissiveUniforms(shader.uniforms, false);
    applyWuWaAlphaWetUniforms(shader.uniforms, shared, awCfg, wcDissolveTex, wcCausticsTex, rgidTex, furTex);
    shader.uniforms.uShaderKind = { value: kindInt };
    shader.uniforms.uSkinTint = { value: new THREE.Vector4(...skinTint) };
    shader.uniforms.uSubsurfaceColor = { value: new THREE.Vector4(...subsurfaceColor) };
    shader.uniforms.uShadowColor = { value: new THREE.Vector4(...shadowColor) };
    shader.uniforms.uRimColor = { value: new THREE.Vector4(...rimColor) };
    shader.uniforms.uRampPos = { value: rampPos };
    shader.uniforms.uRampInt = { value: rampInt };
    shader.uniforms.uShadowProcess = { value: shadowProcess };
    shader.uniforms.uShadowWidth = { value: shadowWidth };
    shader.uniforms.uRimWidth = { value: rimWidth };
    shader.uniforms.uShadowThreshold = { value: shadowThreshold };
    shader.uniforms.uLightDir = shared.uLightDir;
    shader.uniforms.uLightColor = shared.uLightColor;
    shader.uniforms.uAmbientColor = shared.uAmbientColor;
    shader.uniforms.uHeadForward = shared.uHeadForward;
    shader.uniforms.uHeadRight = shared.uHeadRight;
    shader.uniforms.uSdfFlipX = shared.uSdfFlipX;
    shader.uniforms.uSdfOffset = shared.uSdfOffset;
    shader.uniforms.uToonContrast = shared.uToonContrast;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <uv_pars_vertex>',
        `#include <uv_pars_vertex>
        varying vec2 vWuUv0;
        varying vec3 vWuWorldNormal;
        varying vec3 vWuWorldPos;
        #if defined(HAS_WUWA_UV1) && !defined(USE_UV1)
          attribute vec2 uv1;
        #endif
        #ifdef HAS_WUWA_UV1
          varying vec2 vWuUv1;
        #endif
        #if defined(HAS_WUWA_UV2) && !defined(USE_UV2)
          attribute vec2 uv2;
        #endif
        #ifdef HAS_WUWA_UV2
          varying vec2 vWuUv2;
        #endif`
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vWuUv0 = uv;
        #ifdef HAS_WUWA_UV1
          vWuUv1 = uv1;
        #endif
        #ifdef HAS_WUWA_UV2
          vWuUv2 = uv2;
        #endif`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 wuWp = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          wuWp = instanceMatrix * wuWp;
        #endif
        wuWp = modelMatrix * wuWp;
        vWuWorldPos = wuWp.xyz;
        #ifdef HAS_WUWA_NORMAL
          vec3 wuObjN = normal;
          #if defined( USE_MORPHTARGETS ) && defined( USE_MORPHNORMALS )
            for ( int mi = 0; mi < MORPHTARGETS_COUNT; mi ++ ) {
              if ( morphTargetInfluences[ mi ] != 0.0 ) {
                wuObjN += getMorph( gl_VertexID, mi, 1 ).xyz * morphTargetInfluences[ mi ];
              }
            }
          #endif
          #ifdef USE_SKINNING
            mat4 boneMat = boneMatX * skinWeight.x + boneMatY * skinWeight.y + boneMatZ * skinWeight.z + boneMatW * skinWeight.w;
            vec3 skinnedN = ( bindMatrixInverse * ( boneMat * ( bindMatrix * vec4( wuObjN, 0.0 ) ) ) ).xyz;
            vWuWorldNormal = normalize( mat3( modelMatrix ) * skinnedN );
          #else
            vWuWorldNormal = normalize( mat3( modelMatrix ) * wuObjN );
          #endif
        #else
          vWuWorldNormal = vec3(0.0, 1.0, 0.0);
        #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uMainTex;
        uniform sampler2D uMaskTex;
        uniform sampler2D uIdTex;
        uniform sampler2D uNormalTex;
        uniform sampler2D uRampTex;
        uniform sampler2D uEmTex;
        uniform int uShaderKind;
        uniform vec4 uSkinTint;
        uniform vec4 uSubsurfaceColor;
        uniform vec4 uShadowColor;
        uniform vec4 uRimColor;
        ${wuWaEmissiveUniformDecls()}
        ${wuWaAlphaWetUniformDecls()}
        uniform float uRampPos;
        uniform float uRampInt;
        uniform float uShadowProcess;
        uniform float uShadowWidth;
        uniform float uRimWidth;
        uniform float uShadowThreshold;
        uniform vec3 uLightDir;
        uniform vec3 uLightColor;
        uniform vec3 uAmbientColor;
        uniform vec3 uHeadForward;
        uniform vec3 uHeadRight;
        uniform float uSdfFlipX;
        uniform float uSdfOffset;
        uniform float uToonContrast;
        varying vec2 vWuUv0;
        #ifdef HAS_WUWA_UV2
          varying vec2 vWuUv2;
        #endif
        varying vec3 vWuWorldNormal;
        varying vec3 vWuWorldPos;

        vec3 wuPerturbTangent(vec3 N, vec2 uv, vec3 tn) {
          vec3 q0 = dFdx(vWuWorldPos);
          vec3 q1 = dFdy(vWuWorldPos);
          vec2 st0 = dFdx(uv);
          vec2 st1 = dFdy(uv);
          float det = st0.x * st1.y - st1.x * st0.y;
          if (abs(det) < 1e-7) return normalize(N);
          vec3 S = normalize((q0 * st1.y - q1 * st0.y) * sign(det));
          vec3 T = normalize((-q0 * st1.x + q1 * st0.x) * sign(det));
          mat3 TBN = mat3(S, T, normalize(N));
          return normalize(TBN * tn);
        }`
      )
      .replace(
        '#include <opaque_fragment>',
        `
        vec4 baseSample = texture2D(uMainTex, vWuUv0);
        #ifdef IS_EFFECT_VFX
          vec3 vfxMaskSample = texture2D(uMaskTex, vWuUv0).rgb;
          float vfxMask = 1.0;
          #ifdef HAS_MASK_TEX
            vfxMask = clamp(max(vfxMaskSample.r, dot(vfxMaskSample, vec3(0.333))), 0.0, 1.0);
          #endif
          float vfxBaseLum = dot(baseSample.rgb, vec3(0.299, 0.587, 0.114));
          float vfxBaseAlp = baseSample.a < 0.98 ? baseSample.a : vfxBaseLum;
          float vfxEffAlp = clamp(vfxBaseAlp * vfxMask, 0.0, 1.0);
          if (vfxEffAlp < uVfxAlphaClip) discard;
          gl_FragColor = vec4(baseSample.rgb * uVfxTint, vfxEffAlp * opacity);
          return;
        #endif
        float wuFurFeather = 1.0;
        #ifdef HAS_WUWA_FUR
          vec2 wuFurUv = vWuUv0;
          #ifdef HAS_WUWA_UV2
            wuFurUv = vWuUv2;
          #endif
          vec3 wuFurPx = texture2D(uFurTex, wuFurUv).rgb;
          float wuFurMask = clamp(max(wuFurPx.r, dot(wuFurPx, vec3(0.3333))) * uFurAlphaInt, 0.0, 1.0);
          if (wuFurMask < uFurAlphaClip) discard;
          wuFurFeather = smoothstep(uFurAlphaClip, min(uFurAlphaClip + 0.30, 0.92), wuFurMask);
        #endif
        #ifdef USE_ALPHATEST
          #if defined(USE_TYPEMASK_ALPHA) && defined(HAS_ID_TEX)
            float wuMaskAlpha = clamp(texture2D(uIdTex, vWuUv0).r * uOpacityIntensity, 0.0, 1.0);
            float wuTestRgid = uHasRgid > 0.5 ? floor(texture2D(uRgidTex, vWuUv0).r * 255.0 + 0.5) : -1.0;
            bool wuTestSkin = (uHasRgid > 0.5 && uSkinMin >= -0.5 && wuTestRgid >= uSkinMin - 0.3 && wuTestRgid <= uSkinMax + 0.3);
            if (!wuTestSkin && wuMaskAlpha < alphaTest) discard;
          #else
            if (baseSample.a < alphaTest) discard;
          #endif
        #endif

        vec3 V = normalize(cameraPosition - vWuWorldPos);
        vec3 L = normalize(uLightDir);
        vec3 N = normalize(vWuWorldNormal);
        float matMetallic = 0.0;
        float matRoughness = 0.72;

        #ifdef HAS_PACKED_NRM
          vec4 nrmSample = texture2D(uNormalTex, vWuUv0);
          vec2 nXY = (nrmSample.rg * 2.0 - 1.0) * 0.52;
          float nZ = sqrt(max(0.02, 1.0 - clamp(dot(nXY, nXY), 0.0, 0.98)));
          N = wuPerturbTangent(N, vWuUv0, vec3(nXY, nZ));
          matMetallic = clamp(nrmSample.b, 0.0, 1.0);
          matRoughness = clamp(nrmSample.a, 0.08, 0.98);
        #elif defined(HAS_NORMAL_TEX)
          vec3 nTex = texture2D(uNormalTex, vWuUv0).xyz * 2.0 - 1.0;
          if (nTex.z > 0.05) {
            nTex.xy *= 0.52;
            N = wuPerturbTangent(N, vWuUv0, normalize(nTex));
          }
        #endif

        vec3 albedo = baseSample.rgb * uSkinTint.rgb;
        float wuToonNdv = abs(dot(N, V));
        ${wuWaEvaluateAlphaGlsl('baseSample', 'vWuUv0', 'wuToonNdv', 'wuAlphaOut', 'wuWaterTint', 'wuWaterEmit', awCfg.isV2Opacity && Boolean(idTex))}
        ${wuWaWetSurfaceGlsl('vWuUv0', 'vWuWorldPos', 'N', 'V', 'matMetallic', 'mix(0.65, 1.0, matRoughness)', 'wuWetDarken', 'wuWetSpecBoost')}
        if (uAlphaMode >= 2.5) {
          albedo = mix(albedo, albedo + wuWaterTint, 0.42);
        }
        albedo *= wuWetDarken;
        if (uUseStocking > 0.5 && uWetCapable > 0.5 && uWetness > 0.002) {
          albedo *= mix(vec3(1.0), vec3(0.94, 0.89, 0.88), clamp(uWetness, 0.0, 1.0) * 0.5);
        }
        if (uWetCapable > 0.5 && uWetness > 0.002) {
          matRoughness = mix(matRoughness, uWetRoughnessMin, clamp(uWetness, 0.0, 1.0) * 0.85);
        }
        float ndl = dot(N, L);
        float halfLambert = clamp(ndl * 0.5 + 0.5 + uShadowThreshold, 0.0, 1.0);
        float shadeFactor = halfLambert;

        vec3 maskSample = texture2D(uMaskTex, vWuUv0).rgb;
        float specMask = 0.0;
        float aoFactor = 1.0;

        #ifdef USE_COLOR_ALPHA
          aoFactor = mix(0.76, 1.0, clamp(vColor.r, 0.0, 1.0));
        #elif defined(USE_COLOR)
          aoFactor = mix(0.76, 1.0, clamp(vColor.r, 0.0, 1.0));
        #endif

        if (uShaderKind == 4) {
          // Tacet Mark decal (M_Char_XinHen): crisp alpha-clipped mark + subtle emission
          shadeFactor = 1.0;
        } else if (uShaderKind == 1) {
          // WuWa Face: smooth simplified cheek/head normal so anime face stays free of hard SDF seams
          vec3 fFwd = normalize(uHeadForward + vec3(0.0, 0.0, 1e-5));
          vec3 smoothFaceN = normalize(mix(N, normalize(fFwd * 0.65 + vec3(N.x * 0.75, N.y * 0.35, N.z * 0.45)), 0.52));
          float faceHalf = clamp(dot(smoothFaceN, L) * 0.5 + 0.5 + uSdfOffset, 0.0, 1.0);
          shadeFactor = smoothstep(0.30, 0.48, faceHalf);
        } else if (uShaderKind == 2) {
          // WuWa Eye parallax & iris clarity
          vec2 parallaxUv = vWuUv0 + (V.xy * 0.010);
          baseSample = texture2D(uMainTex, parallaxUv);
          albedo = baseSample.rgb * uSkinTint.rgb;
          shadeFactor = clamp(0.86 + 0.14 * halfLambert, 0.0, 1.0);
        } else if (uShaderKind == 3) {
          // WuWa Hair shifted anisotropic specular + wide cel highlight
          vec3 H = normalize(L + V);
          vec3 T = normalize(cross(N, vec3(0.0, 0.0, 1.0)) + vec3(1e-4, 0.0, 0.0));
          float tdh = dot(T, H);
          float hairSpec = pow(max(0.0, sqrt(max(0.0, 1.0 - tdh * tdh))), 28.0);
          specMask = hairSpec * smoothstep(-0.1, 0.35, ndl) * 0.24 * (0.35 + 0.65 * maskSample.g);
          float hairMid = clamp(0.68 - uShadowProcess * 0.35 - uShadowThreshold, 0.28, 0.55);
          float hairW = clamp(uShadowWidth, 0.03, 0.09);
          shadeFactor = smoothstep(hairMid - hairW, hairMid + hairW, halfLambert * aoFactor);
        } else {
          // Body / Clothes
          #ifdef HAS_PACKED_NRM
            vec3 H = normalize(L + V);
            float ndh = max(dot(N, H), 0.0);
            float specPow = mix(56.0, 10.0, matRoughness);
            float specStrength = mix(0.06, 0.52, matMetallic);
            specMask = pow(ndh, specPow) * specStrength * smoothstep(0.0, 0.3, ndl);
          #elif defined(HAS_MASK_TEX)
            aoFactor *= mix(0.75, 1.0, maskSample.r);
            specMask = maskSample.b * pow(max(dot(N, normalize(L + V)), 0.0), mix(48.0, 8.0, clamp(maskSample.g, 0.05, 0.95))) * 0.35;
          #endif
          float bodyMid = clamp(0.66 - uShadowProcess * 0.36 - uShadowThreshold, 0.28, 0.56);
          float bodyW = clamp(uShadowWidth, 0.025, 0.09);
          shadeFactor = smoothstep(bodyMid - bodyW, bodyMid + bodyW, halfLambert * aoFactor);
        }

        // Shadow color: sample ONLY the left-half shadow ramp band and blend gently by uRampInt.
        // Lit surfaces remain un-tinted vec3(1.0) so face/hair/cloth preserve clean albedo colors!
        vec3 baseShadow = mix(vec3(0.66, 0.64, 0.72), uShadowColor.rgb, 0.5);
        if (uShaderKind == 1) {
          baseShadow = vec3(0.84, 0.73, 0.71);
        }
        #ifdef HAS_RAMP_TEX
          float rampRow = clamp(uRampPos, 0.04, 0.96);
          float rampLeftX = clamp(mix(0.04, 0.44, halfLambert * aoFactor), 0.02, 0.46);
          vec3 lutLeft = texture2D(uRampTex, vec2(rampLeftX, rampRow)).rgb;
          float maxLuma = max(lutLeft.r, max(lutLeft.g, lutLeft.b));
          if (maxLuma > 0.02) {
            // Keep LUT tint subtle & balanced (avoids oversaturated red cheeks or neon magenta cloth shadows)
            vec3 normLut = mix(vec3(dot(lutLeft, vec3(0.3, 0.5, 0.2))), lutLeft, 0.55);
            baseShadow = mix(baseShadow, clamp(normLut, vec3(0.35), vec3(0.95)), clamp(uRampInt * (uShaderKind == 1 ? 0.45 : 0.75), 0.0, 0.55));
          }
        #endif

        // Subtle warm SSS terminator band right at cel boundary for Skin / Face
        float terminatorBand = clamp(shadeFactor * (1.0 - shadeFactor) * 4.0, 0.0, 1.0);
        vec3 sssTint = vec3(0.0);
        if (uShaderKind == 1 || uRampPos < 0.2) {
          sssTint = uSubsurfaceColor.rgb * terminatorBand * 0.09;
        }

        float effShade = clamp(mix(shadeFactor, smoothstep(0.0, 1.0, shadeFactor), clamp(uToonContrast - 0.5, 0.0, 1.0)), 0.0, 1.0);
        vec3 shadowAdjusted = mix(vec3(0.82), baseShadow, clamp(uToonContrast * 0.85, 0.35, 1.25));
        vec3 rampTint = mix(shadowAdjusted, vec3(1.0), effShade) + sssTint;

        // Cel Fresnel rim light (gentle contour lift on lit side)
        float fresnel = 1.0 - max(dot(N, V), 0.0);
        float rim = smoothstep(1.0 - clamp(uRimWidth * 0.45, 0.05, 0.42), 1.0, fresnel) * clamp(ndl * 0.5 + 0.65, 0.15, 1.0);
        vec3 rimContrib = uRimColor.rgb * rim * uRimColor.a * 0.28;

        // Specular contribution (metallic-tinted on Metal sections + crisp wet clearcoat)
        vec3 specColor = mix(vec3(1.0), albedo * 1.4, matMetallic);
        vec3 specContrib = specColor * specMask * uLightColor;
        if (uWetCapable > 0.5 && uWetness > 0.002) {
          float wetSpec = pow(max(dot(N, normalize(L + V)), 0.0), 42.0) * smoothstep(0.0, 0.35, ndl);
          specContrib += mix(vec3(1.0), specColor, 0.35) * wetSpec * 0.36 * clamp(uWetness, 0.0, 1.0) * uLightColor;
        }

        // Emissive
        vec2 wuEmUv = uShaderKind == 2 ? (vWuUv0 + (V.xy * 0.010)) : vWuUv0;
        ${wuWaEmissiveComputeGlsl('wuEmUv', 'baseSample', 'emContrib', 'uShaderKind == 2')}
        if (uShaderKind == 4) {
          emContrib += albedo * 0.25;
        }

        float wuToonWetSpecMask = mix(0.28, 1.0, clamp(wuAlphaOut, 0.0, 1.0));
        vec3 litColor = albedo * (rampTint * uLightColor + uAmbientColor * 0.26)
                      + specContrib * mix(0.45, 1.0, wuAlphaOut)
                      + rimContrib * wuToonWetSpecMask
                      + emContrib
                      + wuWetSpecBoost * wuToonWetSpecMask * (0.42 + 0.45 * max(ndl, 0.0)) * uLightColor
                      + wuWaterEmit;

        float finalOutAlpha = (uShaderKind == 2 ? baseSample.a : wuAlphaOut) * wuFurFeather;
        gl_FragColor = vec4(litColor, finalOutAlpha * opacity);
        `
      );
  };

  mainMat.customProgramCacheKey = () =>
    `wuwa-toon-v5-${effectiveShaderKind}-${hasUv1 ? 1 : 0}-${hasUv2 ? 1 : 0}-${awCfg.useFurCard ? 1 : 0}-${hasVColor ? 1 : 0}-${mainTex ? 1 : 0}-${hasPackedNRM ? 1 : 0}-${rampTex ? 1 : 0}-${emTex ? 1 : 0}-${maskTex ? 1 : 0}-${idTex ? 1 : 0}-${secondTex ? 1 : 0}-${noiseMaskTex ? 1 : 0}-${commonNoiseTex ? 1 : 0}-${emCfg.isEffectVfx ? 1 : 0}-${awCfg.alphaMode}-${awCfg.isTransparentMaterial ? 1 : 0}-${awCfg.useSkinProtect ? 1 : 0}-${awCfg.isHairTranslucent ? 1 : 0}-${wcDissolveTex ? 1 : 0}-${wcCausticsTex ? 1 : 0}-${rgidTex ? 1 : 0}-${awCfg.hasTransClothRange ? 1 : 0}-${awCfg.hasWaterClothRange ? 1 : 0}-${awCfg.hasWetClipMask ? 1 : 0}-${awCfg.wetCapable ? 1 : 0}-${awCfg.isV2Opacity && idTex ? 1 : 0}`;

  // Outline Material (_OL) if present! (keep on opaque + skin-protected mixed slots; skip pure translucent sheets/glass/watercloth/fur cards)
  let outlineMat: THREE.Material | null = null;
  if (outlineSlot && effectiveShaderKind !== 'Eye' && !isStarDecal && !emCfg.isEffectVfx && !awCfg.useFurCard && (awCfg.alphaMode === 0 || awCfg.isMixedSkinSlot)) {
    const olWidth = pickScalar(outlineSlot, ['OutlineWidth', 'OutlineClipWidth', 'Width'], 0.0028);
    const olColorVec = pickVec(outlineSlot, ['OutlineColor', 'Color', 'LineColor'], [0.12, 0.09, 0.12, 1.0]);
    const olMainTex = await texCache.load(pickTex(outlineSlot, ['MainTex', 'Diffuse', 'BaseColor']), true);
    const olMasked = !awCfg.isV2Opacity && (Boolean(outlineSlot.blendMode?.includes('Masked')) || isMasked);

    const olMat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      side: THREE.BackSide,
      vertexColors: hasVColor,
      depthWrite: true
    });

    olMat.defines = olMat.defines ?? {};
    olMat.defines.USE_UV = '';
    if (hasUv1) olMat.defines.HAS_WUWA_UV1 = 1;
    if (hasNormal) olMat.defines.HAS_WUWA_NORMAL = 1;
    if (olMainTex || mainTex) olMat.defines.HAS_OL_TEX = 1;
    if (olMasked) olMat.defines.HAS_OL_ALPHA_CLIP = 1;

    olMat.onBeforeCompile = (shader) => {
      shader.uniforms.uOutlineWidth = { value: Math.min(Math.max(olWidth * 0.0022, 0.0012), 0.0065) };
      shader.uniforms.uOutlineWidthScale = shared.uOutlineWidthScale;
      shader.uniforms.uOutlineColor = { value: new THREE.Color(olColorVec[0], olColorVec[1], olColorVec[2]) };
      shader.uniforms.uOutlineTint = shared.uOutlineColorTint;
      shader.uniforms.uOlTex = { value: olMainTex ?? mainTex ?? texCache.white };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <uv_pars_vertex>',
          `#include <uv_pars_vertex>
          varying vec2 vOlUv0;
          uniform float uOutlineWidth;
          uniform float uOutlineWidthScale;
          #if defined(HAS_WUWA_UV1) && !defined(USE_UV1)
            attribute vec2 uv1;
          #endif`
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
          vOlUv0 = uv;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec3 olDir = normal;
          float olThicknessMask = 1.0;
          #ifdef USE_COLOR_ALPHA
            olThicknessMask = clamp(color.g, 0.0, 1.0);
          #elif defined(USE_COLOR)
            olThicknessMask = clamp(color.g, 0.0, 1.0);
          #endif`
        )
        .replace(
          '#include <project_vertex>',
          `vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          mvPosition = modelViewMatrix * mvPosition;
          vec3 extrudeNormal = olDir;
          #ifdef HAS_WUWA_NORMAL
            #if defined( USE_MORPHTARGETS ) && defined( USE_MORPHNORMALS )
              for ( int mi = 0; mi < MORPHTARGETS_COUNT; mi ++ ) {
                if ( morphTargetInfluences[ mi ] != 0.0 ) {
                  extrudeNormal += getMorph( gl_VertexID, mi, 1 ).xyz * morphTargetInfluences[ mi ];
                }
              }
            #endif
            #ifdef USE_SKINNING
              mat4 olBoneMat = boneMatX * skinWeight.x + boneMatY * skinWeight.y + boneMatZ * skinWeight.z + boneMatW * skinWeight.w;
              extrudeNormal = ( bindMatrixInverse * ( olBoneMat * ( bindMatrix * vec4( extrudeNormal, 0.0 ) ) ) ).xyz;
            #endif
          #endif
          vec3 safeN = length(extrudeNormal) > 1e-5 ? normalize(extrudeNormal) : vec3(0.0, 1.0, 0.0);
          vec3 viewN = normalMatrix * safeN;
          viewN = length(viewN) > 1e-5 ? normalize(viewN) : vec3(0.0, 0.0, 1.0);
          float camDist = max(-mvPosition.z, 0.4);
          float distScale = clamp(camDist * 0.45, 0.55, 2.2);
          float w = uOutlineWidth * uOutlineWidthScale * olThicknessMask * distScale;
          mvPosition.xyz += viewN * w;
          gl_Position = projectionMatrix * mvPosition;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform vec3 uOutlineColor;
          uniform vec3 uOutlineTint;
          uniform sampler2D uOlTex;
          varying vec2 vOlUv0;`
        )
        .replace(
          '#include <opaque_fragment>',
          `vec4 texC = texture2D(uOlTex, vOlUv0);
          #ifdef HAS_OL_ALPHA_CLIP
            if (texC.a < 0.25) discard;
          #endif
          vec3 finalOl = mix(texC.rgb * 0.25, uOutlineColor * 0.55, 0.5) * uOutlineTint;
          gl_FragColor = vec4(finalOl, 1.0);`
        );
    };

    olMat.customProgramCacheKey = () =>
      `wuwa-ol-v2-${hasUv1 ? 1 : 0}-${hasVColor ? 1 : 0}-${olMasked ? 1 : 0}`;
    outlineMat = olMat;
  }

  mainMat.userData.useFurCard = awCfg.useFurCard;
  return { mainMat, outlineMat };
}

export function buildMaterialListForManifest(manifest: ModelManifestDto) {
  return manifest.sections.map((sec) => {
    const slot = manifest.materials[sec.materialIndex];
    const outlineSlot = sec.outlineMaterialIndex != null ? manifest.materials[sec.outlineMaterialIndex] : undefined;
    return { sec, slot, outlineSlot };
  });
}
