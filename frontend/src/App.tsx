import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Camera,
  Droplets,
  Eye,
  EyeOff,
  Film,
  Layers,
  Orbit,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sliders,
  Sparkles,
  Sword,
  Trash2
} from 'lucide-react';
import { api } from './api';
import { WuWaViewport } from './components/WuWaViewport';
import { getSlotWetAlphaTags, summarizeManifestWetAlpha } from './shaders/wuwaShaders';
import type {
  AnimationItemDto,
  AnimationPayloadDto,
  CharacterFormDto,
  CharacterSummaryDto,
  CharacterVariantDto,
  CutsceneDetailDto,
  CutsceneSummaryDto,
  InteractiveSphereDto,
  ModelFormMaterialsDto,
  ModelManifestDto,
  PhysicsConfigDto,
  PhysicsRuntimeOptions,
  ShaderRenderMode,
  SocketDto,
  WeaponSummaryDto
} from './types';

type InspectorTab = 'motion' | 'cutscene' | 'physics' | 'shader';

const INITIAL_SPHERES: InteractiveSphereDto[] = [
  {
    id: 'sphere-1',
    name: '테스트 구체 #1 (드래그/충돌)',
    position: [0.0, 0.85, 0.28],
    radius: 0.14,
    enabled: true
  }
];

export function App() {
  // Health & Explorer lists
  const [health, setHealth] = useState<{
    ok: boolean;
    mountedVfs: number;
    totalFiles: number;
    characters: number;
    weapons: number;
    cutscenes: number;
  } | null>(null);
  const [characters, setCharacters] = useState<CharacterSummaryDto[]>([]);
  const [charSearch, setCharSearch] = useState('');
  const [bodyFilter, setBodyFilter] = useState<string>('ALL');

  const [selectedChar, setSelectedChar] = useState<CharacterSummaryDto | null>(null);
  const [selectedVariantIdx, setSelectedVariantIdx] = useState(0);
  const [enabledExtraParts, setEnabledExtraParts] = useState<string[]>([]);
  const [activeFormId, setActiveFormId] = useState<string>('base');
  const [activePrimaryMeshOverride, setActivePrimaryMeshOverride] = useState<string | null>(null);
  const [activeMaterialPresetTag, setActiveMaterialPresetTag] = useState<string | null>(null);
  const [formMaterials, setFormMaterials] = useState<ModelFormMaterialsDto | null>(null);

  // Weapons
  const [weaponSearch, setWeaponSearch] = useState('');
  const [weaponResults, setWeaponResults] = useState<WeaponSummaryDto[]>([]);
  const [equippedWeapon, setEquippedWeapon] = useState<WeaponSummaryDto | null>(null);
  const [weaponAttachBone, setWeaponAttachBone] = useState('WeaponProp01');
  const [availableBones, setAvailableBones] = useState<string[]>([]);
  const [availableSockets, setAvailableSockets] = useState<SocketDto[]>([]);

  // Viewport status & manifest
  const [viewportLoading, setViewportLoading] = useState(false);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ModelManifestDto | null>(null);

  // Inspector tab
  const [activeTab, setActiveTab] = useState<InspectorTab>('motion');

  // Animations & Facial
  const [animations, setAnimations] = useState<AnimationItemDto[]>([]);
  const [includeSharedAnims, setIncludeSharedAnims] = useState(true);
  const [animSearch, setAnimSearch] = useState('');
  const [animCategory, setAnimCategory] = useState('ALL');
  const [selectedAnimItem, setSelectedAnimItem] = useState<AnimationItemDto | null>(null);
  const [activeAnimPayload, setActiveAnimPayload] = useState<AnimationPayloadDto | null>(null);
  const [animLoading, setAnimLoading] = useState(false);
  const [animTime, setAnimTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [animSpeed, setAnimSpeed] = useState(1.0);
  const [animLoop, setAnimLoop] = useState(true);
  const [applyRibbonLayer, setApplyRibbonLayer] = useState(true);
  const [applyFacialCurves, setApplyFacialCurves] = useState(true);
  const [retargetTranslation, setRetargetTranslation] = useState(true);
  const [includeRootMotion, setIncludeRootMotion] = useState(false);
  const [morphTargets, setMorphTargets] = useState<string[]>([]);
  const [morphSearch, setMorphSearch] = useState('');
  const [manualMorphOverrides, setManualMorphOverrides] = useState<Record<string, number>>({});
  const [sampledCurves, setSampledCurves] = useState<Record<string, number>>({});

  // Physics & Spheres
  const [physicsConfig, setPhysicsConfig] = useState<PhysicsConfigDto | null>(null);
  const [physicsReadyStats, setPhysicsReadyStats] = useState<{ groups: number; nodes: number }>({ groups: 0, nodes: 0 });
  const [physicsResetSeq, setPhysicsResetSeq] = useState(0);
  const [physicsRuntime, setPhysicsRuntime] = useState<PhysicsRuntimeOptions>({
    enabled: true,
    stiffnessScale: 1.0,
    dampingScale: 1.0,
    gravityScale: 1.0,
    windStrength: 0.15,
    windFrequency: 2.2,
    showColliders: false,
    showChains: false,
    sphereBounciness: 0.35
  });
  const [spheres, setSpheres] = useState<InteractiveSphereDto[]>(INITIAL_SPHERES);
  const [selectedSphereId, setSelectedSphereId] = useState<string | null>('sphere-1');
  const [sphereAutoOrbit, setSphereAutoOrbit] = useState(false);

  // Shader & Lighting
  const [shaderMode, setShaderMode] = useState<ShaderRenderMode>('wuwa-toon');
  const [showOutlines, setShowOutlines] = useState(true);
  const [outlineWidthScale, setOutlineWidthScale] = useState(1.0);
  const [sdfOffset, setSdfOffset] = useState(0.0);
  const [sdfFlipX, setSdfFlipX] = useState(true);
  const [toonContrast, setToonContrast] = useState(1.0);
  const [wetness, setWetness] = useState(0.0);
  const [wetAlpha, setWetAlpha] = useState(0.85);
  const [lightAzimuth, setLightAzimuth] = useState(38);
  const [lightElevation, setLightElevation] = useState(44);

  const effectiveMaterialOverrides = useMemo(() => {
    if (!activeMaterialPresetTag || !formMaterials) return null;
    return formMaterials.presets.find((p) => p.tag === activeMaterialPresetTag)?.slotOverrides ?? null;
  }, [activeMaterialPresetTag, formMaterials]);

  const effectiveManifestSlots = useMemo(() => {
    if (!manifest) return [];
    if (!effectiveMaterialOverrides) return manifest.materials;
    return manifest.materials.map(
      (slot) => effectiveMaterialOverrides[slot.name] ?? effectiveMaterialOverrides[`MI_${slot.name}`] ?? slot
    );
  }, [manifest, effectiveMaterialOverrides]);

  const wetAlphaSummary = useMemo(
    () => summarizeManifestWetAlpha(effectiveManifestSlots),
    [effectiveManifestSlots]
  );
  const [cameraPresetSignal, setCameraPresetSignal] = useState<{ preset: 'full' | 'face' | 'side' | 'back'; seq: number }>({
    preset: 'full',
    seq: 0
  });

  // Cutscenes
  const [cutsceneList, setCutsceneList] = useState<CutsceneSummaryDto[]>([]);
  const [cutsceneSearch, setCutsceneSearch] = useState('');
  const [cutsceneCategory, setCutsceneCategory] = useState('');
  const [cutsceneFilterByChar, setCutsceneFilterByChar] = useState(false);
  const [cutsceneMode, setCutsceneMode] = useState(false);
  const [activeCutscene, setActiveCutscene] = useState<CutsceneDetailDto | null>(null);
  const [cutsceneTime, setCutsceneTime] = useState(0);
  const [cutscenePlaying, setCutscenePlaying] = useState(true);
  const [cutsceneUseCamera, setCutsceneUseCamera] = useState(true);
  const [cutsceneSpeed, setCutsceneSpeed] = useState(1.0);
  const [cutsceneLoop, setCutsceneLoop] = useState(true);
  const [cutsceneStatus, setCutsceneStatus] = useState<{
    loading: boolean;
    loadedActors: number;
    totalActors: number;
    loadedAnims: number;
  }>({ loading: false, loadedActors: 0, totalActors: 0, loadedAnims: 0 });

  // Initial load: health + characters + default Yangyang
  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
    api
      .characters()
      .then((list) => {
        setCharacters(list);
        const preferred =
          list.find((c) => c.name.toLowerCase() === 'yangyang') ??
          list.find((c) => c.hasPhysics && c.animCount > 0) ??
          list[0];
        if (preferred) selectCharacter(preferred);
      })
      .catch((err) => setViewportError(err instanceof Error ? err.message : 'Backend connection failed'));
  }, []);

  const applyVariantDefaults = useCallback((v: CharacterVariantDto | null) => {
    const defaults = v ? v.extraParts.filter((ep) => ep.defaultVisible).map((ep) => ep.componentName) : [];
    setEnabledExtraParts(defaults);
    setActiveFormId('base');
    setActivePrimaryMeshOverride(null);
    setActiveMaterialPresetTag(null);
  }, []);

  const selectCharacter = useCallback(async (char: CharacterSummaryDto) => {
    setSelectedChar(char);
    setSelectedVariantIdx(0);
    setEnabledExtraParts([]);
    setActiveFormId('base');
    setActivePrimaryMeshOverride(null);
    setActiveMaterialPresetTag(null);
    setFormMaterials(null);
    setEquippedWeapon(null);
    setSelectedAnimItem(null);
    setActiveAnimPayload(null);
    setAnimTime(0);
    setIsPlaying(false);
    setManualMorphOverrides({});
    setSampledCurves({});
    setCutsceneMode(false);

    try {
      const detail = await api.characterDetail(char.id);
      setSelectedChar(detail);
      applyVariantDefaults(detail.variants[0] ?? null);
    } catch {
      // Keep summary if detail fails
    }
  }, [applyVariantDefaults]);

  // Fetch character animations + physics when character / includeShared changes
  useEffect(() => {
    if (!selectedChar) return;
    api
      .animations(selectedChar.id, includeSharedAnims)
      .then((list) => setAnimations(list))
      .catch(() => setAnimations([]));
  }, [selectedChar?.id, includeSharedAnims]);

  const activeVariant = selectedChar?.variants[selectedVariantIdx] ?? selectedChar?.variants[0] ?? null;
  const effectivePrimaryMeshPath = activePrimaryMeshOverride || activeVariant?.primaryMeshPath || null;

  useEffect(() => {
    if (!effectivePrimaryMeshPath) {
      setFormMaterials(null);
      return;
    }
    let cancelled = false;
    api
      .modelFormMaterials(effectivePrimaryMeshPath)
      .then((res) => {
        if (!cancelled) setFormMaterials(res);
      })
      .catch(() => {
        if (!cancelled) setFormMaterials(null);
      });
    return () => {
      cancelled = true;
    };
  }, [effectivePrimaryMeshPath]);

  const availableForms = useMemo(() => {
    const list: CharacterFormDto[] = [...(activeVariant?.forms ?? [])];
    const loadedMatchesMesh =
      formMaterials &&
      effectivePrimaryMeshPath &&
      formMaterials.meshPath.toLowerCase() === effectivePrimaryMeshPath.toLowerCase();

    const filtered = list.filter((f) => {
      if (f.kind !== 'Material' || !f.materialPresetTag || !loadedMatchesMesh) return true;
      return formMaterials.presets.some((p) => p.tag.toLowerCase() === f.materialPresetTag!.toLowerCase());
    });

    if (formMaterials?.presets.length) {
      for (const preset of formMaterials.presets) {
        if (!filtered.some((f) => f.materialPresetTag?.toLowerCase() === preset.tag.toLowerCase())) {
          filtered.push({
            id: `mat_${preset.tag}`,
            name: preset.name,
            kind: 'Material',
            description: '머티리얼 / 텍스처 변형',
            materialPresetTag: preset.tag
          });
        }
      }
      if (filtered.length > 0 && filtered[0].id !== 'base') {
        filtered.unshift({ id: 'base', name: '기본 폼', kind: 'Base', description: '기본 외형' });
      }
    }
    return filtered;
  }, [activeVariant?.forms, formMaterials, effectivePrimaryMeshPath]);

  const applyFormPreset = useCallback(
    (form: CharacterFormDto) => {
      if (!activeVariant) return;
      if (form.linkedCharacterId) {
        const linked = characters.find((c) => c.id.toLowerCase() === form.linkedCharacterId!.toLowerCase());
        if (linked) selectCharacter(linked);
        return;
      }
      setActiveFormId(form.id);
      const defaults = activeVariant.extraParts.filter((ep) => ep.defaultVisible).map((ep) => ep.componentName);
      if (form.kind === 'Base' || form.id === 'base') {
        setActivePrimaryMeshOverride(null);
        setActiveMaterialPresetTag(null);
        setEnabledExtraParts(defaults);
      } else if (form.kind === 'Material') {
        setActiveMaterialPresetTag(form.materialPresetTag ?? null);
      } else {
        setActivePrimaryMeshOverride(form.overridePrimaryMeshPath ?? null);
        setActiveMaterialPresetTag(form.materialPresetTag ?? null);
        const nextParts = new Set<string>(defaults);
        for (const p of form.enableParts ?? []) nextParts.add(p);
        for (const p of form.disableParts ?? []) nextParts.delete(p);
        setEnabledExtraParts(Array.from(nextParts));
      }
      if (form.morphOverrides) {
        setManualMorphOverrides((prev) => ({ ...prev, ...form.morphOverrides }));
      }
    },
    [activeVariant, characters, selectCharacter]
  );

  useEffect(() => {
    if (!selectedChar) {
      setPhysicsConfig(null);
      return;
    }
    api
      .physics(selectedChar.id, activeVariant?.defaultAbpPath)
      .then((cfg) => setPhysicsConfig(cfg))
      .catch(() => setPhysicsConfig(null));
  }, [selectedChar?.id, activeVariant?.defaultAbpPath]);

  // Weapon search
  useEffect(() => {
    const t = setTimeout(() => {
      api.weapons(weaponSearch.trim() || undefined, 80).then(setWeaponResults).catch(() => setWeaponResults([]));
    }, 180);
    return () => clearTimeout(t);
  }, [weaponSearch]);

  // Cutscene list query
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .cutscenes({
          character: cutsceneFilterByChar && selectedChar ? selectedChar.name : undefined,
          category: cutsceneCategory || undefined,
          q: cutsceneSearch.trim() || undefined,
          limit: 120
        })
        .then(setCutsceneList)
        .catch(() => setCutsceneList([]));
    }, 200);
    return () => clearTimeout(t);
  }, [cutsceneSearch, cutsceneCategory, cutsceneFilterByChar, selectedChar?.name]);

  const handleSelectAnimation = async (item: AnimationItemDto) => {
    setSelectedAnimItem(item);
    setAnimLoading(true);
    setCutsceneMode(false);
    try {
      const payload = await api.animation(item.path, item.ribbonPath);
      setActiveAnimPayload(payload);
      setAnimTime(0);
      setIsPlaying(true);
    } catch (err) {
      setViewportError(err instanceof Error ? err.message : 'Animation load failed');
    } finally {
      setAnimLoading(false);
    }
  };

  const handleSelectCutscene = async (item: CutsceneSummaryDto) => {
    try {
      const detail = await api.cutsceneDetail(item.path);
      setActiveCutscene(detail);
      setCutsceneTime(0);
      setCutscenePlaying(true);
      setCutsceneMode(true);
    } catch (err) {
      setViewportError(err instanceof Error ? err.message : 'Cutscene load failed');
    }
  };

  const filteredChars = useMemo(() => {
    const q = charSearch.trim().toLowerCase();
    return characters.filter((c) => {
      if (bodyFilter !== 'ALL' && c.bodyType !== bodyFilter) return false;
      if (q && !c.name.toLowerCase().includes(q) && !c.bodyType.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [characters, charSearch, bodyFilter]);

  const animCategories = useMemo(() => {
    const cats = new Set<string>(['ALL']);
    for (const a of animations) cats.add(a.category || 'Other');
    return Array.from(cats);
  }, [animations]);

  const filteredAnims = useMemo(() => {
    const q = animSearch.trim().toLowerCase();
    return animations.filter((a) => {
      if (animCategory !== 'ALL' && a.category !== animCategory) return false;
      if (q && !a.name.toLowerCase().includes(q) && !a.category.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [animations, animSearch, animCategory]);

  const filteredMorphs = useMemo(() => {
    const q = morphSearch.trim().toLowerCase();
    if (!q) return morphTargets;
    return morphTargets.filter((m) => m.toLowerCase().includes(q));
  }, [morphTargets, morphSearch]);

  const bodyTypes = useMemo(() => {
    const s = new Set<string>(['ALL']);
    for (const c of characters) s.add(c.bodyType);
    return Array.from(s);
  }, [characters]);

  const selectedSphere = useMemo(() => spheres.find((s) => s.id === selectedSphereId) ?? null, [spheres, selectedSphereId]);

  const handleUpdateSpherePos = useCallback((id: string, pos: [number, number, number]) => {
    setSpheres((prev) => prev.map((s) => (s.id === id ? { ...s, position: pos } : s)));
  }, []);

  const addSphere = () => {
    const nextIdx = spheres.length + 1;
    const id = `sphere-${Date.now()}`;
    const next: InteractiveSphereDto = {
      id,
      name: `구체 #${nextIdx}`,
      position: [0.18 * ((nextIdx % 3) - 1), 0.75 + (nextIdx % 3) * 0.25, 0.25],
      radius: 0.14,
      enabled: true
    };
    setSpheres((prev) => [...prev, next]);
    setSelectedSphereId(id);
  };

  const triggerCamPreset = (preset: 'full' | 'face' | 'side' | 'back') => {
    setCameraPresetSignal((prev) => ({ preset, seq: prev.seq + 1 }));
  };

  const activeCurveEntries = useMemo(() => {
    const morphSet = new Set(morphTargets.map((m) => m.toLowerCase()));
    const entries = Object.entries(sampledCurves).filter(([, v]) => Number.isFinite(v) && Math.abs(v) > 0.005);
    const facial = morphSet.size > 0
      ? entries.filter(([k]) => morphSet.has(k.toLowerCase()))
      : entries;
    const list = facial.length > 0 ? facial : entries;
    return list.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12);
  }, [sampledCurves, morphTargets]);

  const totalTransportDuration = cutsceneMode && activeCutscene ? activeCutscene.duration : activeAnimPayload?.duration ?? 0;
  const currentTransportTime = cutsceneMode ? cutsceneTime : animTime;
  const transportPlaying = cutsceneMode ? cutscenePlaying : isPlaying;

  return (
    <div className="w-screen h-screen flex flex-col bg-[#090d14] text-slate-100 overflow-hidden">
      {/* TOP BAR */}
      <header className="h-11 px-3 border-b border-slate-800 bg-[#0d121d] flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 font-semibold text-sm tracking-tight text-amber-300">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>WuWaViewer</span>
            <span className="text-[11px] font-normal text-slate-400 hidden sm:inline">명조 3D 모션·셰이더·컷신·물리 스튜디오</span>
          </div>
          {health && (
            <div className="hidden lg:flex items-center gap-2 text-[11px] text-slate-400 bg-slate-900/80 border border-slate-800 rounded-md px-2 py-0.5">
              <span className="text-emerald-400">● VFS {health.mountedVfs}</span>
              <span>캐릭터 {health.characters}</span>
              <span>·</span>
              <span>무기 {health.weapons}</span>
              <span>·</span>
              <span>컷신 {health.cutscenes.toLocaleString()}</span>
            </div>
          )}
        </div>

        {/* Camera & Shader Quick Controls */}
        <div className="flex items-center gap-2">
          {cutsceneMode && (
            <button
              onClick={() => setCutsceneMode(false)}
              className="px-2.5 py-1 rounded text-xs font-medium bg-rose-600/20 text-rose-300 border border-rose-500/40 hover:bg-rose-600/30"
            >
              컷신 종료 → 캐릭터 보기
            </button>
          )}

          <div className="hidden md:flex items-center bg-slate-900 border border-slate-800 rounded-md p-0.5 text-[11px]">
            {(
              [
                ['full', '전신'],
                ['face', '얼굴'],
                ['side', '측면'],
                ['back', '후면']
              ] as const
            ).map(([p, label]) => (
              <button
                key={p}
                onClick={() => triggerCamPreset(p)}
                className="px-2 py-0.5 rounded hover:bg-slate-800 text-slate-300 hover:text-white transition"
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-md p-0.5 text-[11px]">
            {(
              [
                ['wuwa-toon', '명조 Toon'],
                ['pbr', 'PBR'],
                ['flat-albedo', 'Albedo'],
                ['wireframe', 'Wire']
              ] as [ShaderRenderMode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setShaderMode(m)}
                className={`px-2 py-0.5 rounded transition ${
                  shaderMode === m ? 'bg-amber-500/20 text-amber-300 font-medium' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowOutlines((v) => !v)}
            className={`px-2 py-1 rounded text-[11px] border transition ${
              showOutlines
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
          >
            외곽선 {showOutlines ? 'ON' : 'OFF'}
          </button>
        </div>
      </header>

      {/* MAIN 3-COLUMN WORKSPACE */}
      <div className="flex-1 flex min-h-0">
        {/* LEFT EXPLORER: CHARACTERS & WEAPONS */}
        <aside className="w-72 border-r border-slate-800 bg-[#0b101b] flex flex-col min-h-0 shrink-0">
          <div className="p-2.5 border-b border-slate-800/80 space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
              <input
                type="text"
                value={charSearch}
                onChange={(e) => setCharSearch(e.target.value)}
                placeholder="캐릭터 검색 (Yangyang, Zanni...)"
                className="w-full bg-slate-900 border border-slate-800 rounded-md pl-8 pr-2.5 py-1 text-xs focus:outline-none focus:border-amber-500/60"
              />
            </div>

            <div className="flex flex-wrap gap-1">
              {bodyTypes.slice(0, 6).map((bt) => (
                <button
                  key={bt}
                  onClick={() => setBodyFilter(bt)}
                  className={`px-1.5 py-0.5 rounded text-[10px] border transition ${
                    bodyFilter === bt
                      ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {bt}
                </button>
              ))}
            </div>
          </div>

          {/* Character List */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/50 min-h-0">
            {filteredChars.map((char) => {
              const active = selectedChar?.id === char.id;
              return (
                <button
                  key={char.id}
                  onClick={() => selectCharacter(char)}
                  className={`w-full text-left px-3 py-2 flex items-center justify-between hover:bg-slate-800/50 transition ${
                    active ? 'bg-amber-500/10 border-l-2 border-l-amber-400' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className={`text-xs font-medium truncate ${active ? 'text-amber-300' : 'text-slate-200'}`}>
                      {char.name}
                    </div>
                    <div className="text-[10px] text-slate-500 flex items-center gap-1.5">
                      <span>{char.bodyType}</span>
                      {char.hasPhysics && <span className="text-emerald-400/80">· Phy</span>}
                      <span>· {char.variants.length}v</span>
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-400 shrink-0 tabular-nums">{char.animCount}M</div>
                </button>
              );
            })}
          </div>

          {/* Active Character Variants + Weapon Section */}
          {selectedChar && (
            <div className="border-t border-slate-800 bg-[#0d1320] p-2.5 space-y-2 max-h-[44%] overflow-y-auto shrink-0">
              {selectedChar.variants.length > 1 && (
                <div>
                  <label className="text-[10px] text-slate-400 block mb-1">코스튬 / 스킨 변형</label>
                  <select
                    value={selectedVariantIdx}
                    onChange={(e) => {
                      const idx = Number(e.target.value);
                      setSelectedVariantIdx(idx);
                      applyVariantDefaults(selectedChar.variants[idx] ?? null);
                    }}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                  >
                    {selectedChar.variants.map((v, idx) => (
                      <option key={v.id} value={idx}>
                        {v.name} ({v.id})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {activeVariant && activeVariant.linkedForms && activeVariant.linkedForms.length > 0 && (
                <div>
                  <div className="text-[10px] text-fuchsia-300 font-medium mb-1">연계 변신 폼 (독립 모델)</div>
                  <div className="flex flex-wrap gap-1">
                    {activeVariant.linkedForms.map((lf) => (
                      <button
                        key={lf.characterId}
                        onClick={() => {
                          const linked = characters.find((c) => c.id.toLowerCase() === lf.characterId.toLowerCase());
                          if (linked) selectCharacter(linked);
                        }}
                        className="px-2 py-1 rounded text-[10px] font-medium bg-fuchsia-500/20 border border-fuchsia-500/50 text-fuchsia-200 hover:bg-fuchsia-500/30 transition"
                        title={lf.characterId}
                      >
                        {lf.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {availableForms.length > 0 && (
                <div>
                  <div className="text-[10px] text-amber-300 font-medium mb-1">변신 / 외형 프리셋 ({availableForms.length})</div>
                  <div className="flex flex-wrap gap-1">
                    {availableForms.map((f) => {
                      const isMatActive =
                        f.kind === 'Material' &&
                        f.materialPresetTag != null &&
                        activeMaterialPresetTag?.toLowerCase() === f.materialPresetTag.toLowerCase();
                      const isSelected = activeFormId === f.id || isMatActive;
                      return (
                        <button
                          key={f.id}
                          onClick={() => applyFormPreset(f)}
                          title={f.description ?? f.name}
                          className={`px-2 py-0.5 rounded text-[10px] border transition ${
                            isSelected
                              ? f.kind === 'Material'
                                ? 'bg-emerald-500/25 border-emerald-400/70 text-emerald-200'
                                : 'bg-amber-500/25 border-amber-400/70 text-amber-200'
                              : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-500'
                          }`}
                        >
                          {f.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {activeVariant && activeVariant.extraParts.length > 0 && (
                <div>
                  <div className="text-[10px] text-slate-400 mb-1">추가 파츠 / 소품 ({activeVariant.extraParts.length})</div>
                  <div className="flex flex-wrap gap-1">
                    {activeVariant.extraParts.map((ep) => {
                      const checked = enabledExtraParts.includes(ep.componentName);
                      const kindColor =
                        ep.partKind === 'Prop'
                          ? checked
                            ? 'bg-amber-500/20 border-amber-500/50 text-amber-200'
                            : 'bg-slate-900 border-slate-800 text-slate-400'
                          : ep.partKind === 'WeaponProp'
                          ? checked
                            ? 'bg-violet-500/20 border-violet-500/50 text-violet-200'
                            : 'bg-slate-900 border-slate-800 text-slate-500'
                          : checked
                          ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                          : 'bg-slate-900 border-slate-800 text-slate-400';
                      return (
                        <button
                          key={ep.componentName}
                          title={ep.attachSocket ? `소켓: ${ep.attachSocket}` : '스켈레톤 공유 / 루트'}
                          onClick={() => {
                            setActiveFormId('custom');
                            setEnabledExtraParts((prev) =>
                              checked ? prev.filter((x) => x !== ep.componentName) : [...prev, ep.componentName]
                            );
                          }}
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${kindColor}`}
                        >
                          {ep.componentName}
                          {ep.partKind === 'Prop' ? ' ·소품' : ep.partKind === 'WeaponProp' ? ' ·무장' : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Weapon Equiper */}
              <div className="pt-1 border-t border-slate-800/80 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-300 flex items-center gap-1">
                    <Sword className="w-3 h-3 text-amber-400" />
                    무기 장착
                  </span>
                  {equippedWeapon && (
                    <button
                      onClick={() => setEquippedWeapon(null)}
                      className="text-[10px] text-rose-400 hover:underline"
                    >
                      장착 해제
                    </button>
                  )}
                </div>

                <div className="relative">
                  <Search className="w-3 h-3 text-slate-500 absolute left-2 top-1.5" />
                  <input
                    type="text"
                    value={weaponSearch}
                    onChange={(e) => setWeaponSearch(e.target.value)}
                    placeholder="무기 검색 (Sword, Broadblade...)"
                    className="w-full bg-slate-900 border border-slate-800 rounded pl-6 pr-2 py-1 text-[11px]"
                  />
                </div>

                {equippedWeapon && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-400 shrink-0">본/소켓:</span>
                    <select
                      value={weaponAttachBone}
                      onChange={(e) => setWeaponAttachBone(e.target.value)}
                      className="flex-1 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-[10px]"
                    >
                      <option value="WeaponProp01">WeaponProp01</option>
                      <option value="WeaponProp02">WeaponProp02</option>
                      <option value="Bip001RHand">Bip001RHand</option>
                      <option value="Bip001LHand">Bip001LHand</option>
                      {availableSockets.map((s) => (
                        <option key={s.name} value={s.name}>
                          Socket: {s.name}
                        </option>
                      ))}
                      {availableBones
                        .filter((b) => b.includes('weapon') || b.includes('hand'))
                        .slice(0, 12)
                        .map((b) => (
                          <option key={b} value={b}>
                            Bone: {b}
                          </option>
                        ))}
                    </select>
                  </div>
                )}

                <div className="max-h-24 overflow-y-auto space-y-0.5 pr-0.5">
                  {(weaponSearch.trim() ? weaponResults : selectedChar.suggestedWeapons.length > 0 ? selectedChar.suggestedWeapons : weaponResults.slice(0, 12)).map(
                    (w) => {
                      const isEq = equippedWeapon?.meshPath === w.meshPath;
                      return (
                        <button
                          key={w.id}
                          onClick={() => setEquippedWeapon(w)}
                          className={`w-full text-left px-2 py-1 rounded text-[10px] flex justify-between items-center transition ${
                            isEq ? 'bg-amber-500/20 text-amber-300' : 'hover:bg-slate-800/70 text-slate-300'
                          }`}
                        >
                          <span className="truncate">{w.name}</span>
                          <span className="text-[9px] text-slate-500 ml-1 shrink-0">{w.category}</span>
                        </button>
                      );
                    }
                  )}
                </div>
              </div>
            </div>
          )}
        </aside>

        {/* CENTER 3D VIEWPORT */}
        <main className="flex-1 relative min-w-0 bg-[#070a10]">
          <WuWaViewport
            characterVariant={activeVariant}
            activePrimaryMeshOverride={activePrimaryMeshOverride}
            formMaterials={formMaterials}
            activeMaterialPresetTag={activeMaterialPresetTag}
            enabledExtraParts={enabledExtraParts}
            equippedWeapon={equippedWeapon}
            weaponAttachBone={weaponAttachBone}
            activeAnimation={activeAnimPayload}
            animTime={animTime}
            isPlaying={isPlaying}
            animSpeed={animSpeed}
            animLoop={animLoop}
            applyRibbonLayer={applyRibbonLayer}
            applyFacialCurves={applyFacialCurves}
            retargetTranslation={retargetTranslation}
            includeRootMotion={includeRootMotion}
            manualMorphOverrides={manualMorphOverrides}
            onAnimTimeChange={setAnimTime}
            onPlayingChange={setIsPlaying}
            onMorphTargetsLoaded={setMorphTargets}
            onBonesLoaded={(bones, sockets) => {
              setAvailableBones(bones);
              setAvailableSockets(sockets);
            }}
            onActiveCurvesSampled={setSampledCurves}
            onPhysicsReady={(groups, nodes) => setPhysicsReadyStats({ groups, nodes })}
            onManifestLoaded={setManifest}
            onLoadingChange={(loading, err) => {
              setViewportLoading(loading);
              setViewportError(err);
            }}
            physicsConfig={physicsConfig}
            physicsRuntime={physicsRuntime}
            physicsResetSignal={physicsResetSeq}
            spheres={spheres}
            selectedSphereId={selectedSphereId}
            sphereAutoOrbit={sphereAutoOrbit}
            onSelectSphere={setSelectedSphereId}
            onUpdateSpherePos={handleUpdateSpherePos}
            shaderMode={shaderMode}
            showOutlines={showOutlines}
            outlineWidthScale={outlineWidthScale}
            sdfOffset={sdfOffset}
            sdfFlipX={sdfFlipX}
            toonContrast={toonContrast}
            wetness={wetness}
            wetAlpha={wetAlpha}
            lightAzimuth={lightAzimuth}
            lightElevation={lightElevation}
            activeCutscene={activeCutscene}
            cutsceneMode={cutsceneMode}
            cutsceneTime={cutsceneTime}
            cutscenePlaying={cutscenePlaying}
            cutsceneUseCamera={cutsceneUseCamera}
            cutsceneSpeed={cutsceneSpeed}
            cutsceneLoop={cutsceneLoop}
            onCutsceneTimeChange={setCutsceneTime}
            onCutsceneStatusChange={setCutsceneStatus}
            cameraPresetSignal={cameraPresetSignal}
          />

          {/* Top-left HUD Overlay */}
          <div className="absolute top-3 left-3 flex flex-col gap-1.5 pointer-events-none">
            <div className="bg-slate-950/80 backdrop-blur border border-slate-800/90 rounded-lg px-3 py-1.5 text-xs flex items-center gap-2.5">
              {cutsceneMode && activeCutscene ? (
                <>
                  <Film className="w-3.5 h-3.5 text-amber-400" />
                  <span className="font-medium text-amber-300">{activeCutscene.name}</span>
                  <span className="text-slate-400">
                    액터 {cutsceneStatus.loadedActors}/{cutsceneStatus.totalActors} · 애니 {cutsceneStatus.loadedAnims}
                  </span>
                </>
              ) : (
                <>
                  <span className="font-medium text-slate-100">{selectedChar?.name ?? '로딩중...'}</span>
                  {manifest && (
                    <span className="text-[11px] text-slate-400">
                      섹션 {manifest.sections.length} · 모프 {morphTargets.length}
                    </span>
                  )}
                  <span className="text-[11px] text-emerald-400">
                    물리 {physicsReadyStats.groups}그룹/{physicsReadyStats.nodes}본
                  </span>
                </>
              )}
              {(viewportLoading || animLoading || cutsceneStatus.loading) && (
                <span className="text-cyan-400 animate-pulse">로딩 중...</span>
              )}
            </div>

            {viewportError && (
              <div className="bg-rose-950/90 border border-rose-500/50 text-rose-200 rounded-lg px-3 py-1.5 text-xs max-w-md pointer-events-auto">
                {viewportError}
              </div>
            )}
          </div>

          {/* Bottom Timeline Transport Overlay */}
          {totalTransportDuration > 0 && (
            <div className="absolute bottom-3 left-3 right-3 bg-slate-950/85 backdrop-blur border border-slate-800/90 rounded-xl px-3 py-2 flex items-center gap-3">
              <button
                onClick={() => (cutsceneMode ? setCutscenePlaying((v) => !v) : setIsPlaying((v) => !v))}
                className="w-7 h-7 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 flex items-center justify-center shrink-0"
              >
                {transportPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>

              <div className="text-[11px] font-mono text-slate-300 w-24 shrink-0 tabular-nums">
                {currentTransportTime.toFixed(2)}s / {totalTransportDuration.toFixed(2)}s
              </div>

              <input
                type="range"
                min={0}
                max={Math.max(totalTransportDuration, 0.01)}
                step={0.01}
                value={Math.min(currentTransportTime, totalTransportDuration)}
                onChange={(e) => {
                  const t = Number(e.target.value);
                  if (cutsceneMode) {
                    setCutscenePlaying(false);
                    setCutsceneTime(t);
                  } else {
                    setIsPlaying(false);
                    setAnimTime(t);
                  }
                }}
                className="flex-1 accent-amber-400 cursor-pointer"
              />

              <select
                value={cutsceneMode ? cutsceneSpeed : animSpeed}
                onChange={(e) => {
                  const s = Number(e.target.value);
                  if (cutsceneMode) setCutsceneSpeed(s);
                  else setAnimSpeed(s);
                }}
                className="bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-[11px]"
              >
                {[0.25, 0.5, 1.0, 1.5, 2.0].map((sp) => (
                  <option key={sp} value={sp}>
                    {sp}x
                  </option>
                ))}
              </select>

              <button
                onClick={() => (cutsceneMode ? setCutsceneLoop((v) => !v) : setAnimLoop((v) => !v))}
                className={`px-2 py-0.5 rounded text-[11px] border ${
                  (cutsceneMode ? cutsceneLoop : animLoop)
                    ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                반복
              </button>

              {!cutsceneMode && (
                <button
                  onClick={() => {
                    setIsPlaying(false);
                    setActiveAnimPayload(null);
                    setSelectedAnimItem(null);
                    setAnimTime(0);
                    setPhysicsResetSeq((s) => s + 1);
                  }}
                  title="T-Pose / Rest Pose 초기화"
                  className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </main>

        {/* RIGHT INSPECTOR PANEL */}
        <aside className="w-96 border-l border-slate-800 bg-[#0b101b] flex flex-col min-h-0 shrink-0">
          {/* Inspector Tabs */}
          <div className="grid grid-cols-4 border-b border-slate-800 bg-[#0d121d] text-[11px]">
            {(
              [
                ['motion', '모션/표정', Play],
                ['cutscene', '컷신', Film],
                ['physics', '물리/충돌', Orbit],
                ['shader', '셰이더', Sliders]
              ] as const
            ).map(([id, label, Icon]) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={`py-2.5 px-1 flex flex-col items-center gap-1 border-b-2 transition ${
                    active
                      ? 'border-amber-400 text-amber-300 bg-amber-500/5 font-medium'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          {/* TAB 1: MOTION & FACIAL MORPHS */}
          {activeTab === 'motion' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="p-2.5 border-b border-slate-800/80 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
                    <input
                      type="text"
                      value={animSearch}
                      onChange={(e) => setAnimSearch(e.target.value)}
                      placeholder="모션 검색 (Attack, Skill, Burst, UI...)"
                      className="w-full bg-slate-900 border border-slate-800 rounded pl-8 pr-2 py-1 text-xs"
                    />
                  </div>
                  <label className="flex items-center gap-1 text-[10px] text-slate-300 cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      checked={includeSharedAnims}
                      onChange={(e) => setIncludeSharedAnims(e.target.checked)}
                      className="accent-amber-400"
                    />
                    공용Base
                  </label>
                </div>

                <div className="flex flex-wrap gap-1">
                  {animCategories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setAnimCategory(cat)}
                      className={`px-1.5 py-0.5 rounded text-[10px] border ${
                        animCategory === cat
                          ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-1.5 text-[10px] text-slate-300 pt-0.5">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={applyRibbonLayer}
                      onChange={(e) => setApplyRibbonLayer(e.target.checked)}
                      className="accent-cyan-400"
                    />
                    Rib_* 리본 레이어
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={applyFacialCurves}
                      onChange={(e) => setApplyFacialCurves(e.target.checked)}
                      className="accent-cyan-400"
                    />
                    얼굴 ACL 커브
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={retargetTranslation}
                      onChange={(e) => setRetargetTranslation(e.target.checked)}
                      className="accent-cyan-400"
                    />
                    본 이동 리타겟
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeRootMotion}
                      onChange={(e) => setIncludeRootMotion(e.target.checked)}
                      className="accent-cyan-400"
                    />
                    Root Motion
                  </label>
                </div>
              </div>

              {/* Animation List */}
              <div className="flex-1 overflow-y-auto divide-y divide-slate-800/40 min-h-0">
                {filteredAnims.map((item, idx) => {
                  const active = selectedAnimItem?.id === item.id && !cutsceneMode;
                  return (
                    <button
                      key={`${item.id}::${idx}`}
                      onClick={() => handleSelectAnimation(item)}
                      className={`w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-slate-800/50 transition ${
                        active ? 'bg-amber-500/15 border-l-2 border-l-amber-400' : ''
                      }`}
                    >
                      <div className="min-w-0 pr-2">
                        <div className={`text-xs truncate ${active ? 'text-amber-300 font-medium' : 'text-slate-200'}`}>
                          {item.name}
                        </div>
                        <div className="text-[10px] text-slate-500 flex items-center gap-1.5">
                          <span className="text-slate-400">{item.category}</span>
                          <span>· {item.kind}</span>
                          {item.hasRibbonLayer && <span className="text-cyan-400">· Rib+</span>}
                          {item.isSharedBase && <span className="text-violet-400">· Base</span>}
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-slate-400 shrink-0 tabular-nums">
                        {item.duration > 0 ? `${item.duration.toFixed(2)}s` : '-'}
                      </span>
                    </button>
                  );
                })}
                {filteredAnims.length === 0 && (
                  <div className="p-4 text-xs text-slate-500 text-center">검색된 모션이 없습니다</div>
                )}
              </div>

              {/* Active Curves + Manual Facial Morphs */}
              <div className="border-t border-slate-800 bg-[#0d1320] p-2.5 max-h-[42%] flex flex-col min-h-0 shrink-0">
                {activeCurveEntries.length > 0 && (
                  <div className="mb-2 pb-1.5 border-b border-slate-800/70">
                    <div className="text-[10px] text-cyan-300 mb-1">실시간 표정 ACL 커브 ({activeCurveEntries.length})</div>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 max-h-14 overflow-y-auto">
                      {activeCurveEntries.map(([name, val]) => (
                        <div key={name} className="flex items-center justify-between text-[10px]">
                          <span className="truncate text-slate-400 mr-1">{name}</span>
                          <span className="font-mono text-cyan-300 shrink-0">{val.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="text-[11px] font-medium text-slate-300">수동 표정 Morph ({morphTargets.length})</span>
                  <button
                    onClick={() => setManualMorphOverrides({})}
                    className="text-[10px] text-slate-400 hover:text-white"
                  >
                    초기화
                  </button>
                </div>

                <input
                  type="text"
                  value={morphSearch}
                  onChange={(e) => setMorphSearch(e.target.value)}
                  placeholder="Morph 이름 검색 (Eye, Mouth, Wink...)"
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[11px] mb-1.5"
                />

                <div className="flex-1 overflow-y-auto space-y-1 pr-1 min-h-0">
                  {filteredMorphs.some((m) => /^S_(1[2-9]|[2-9]\d)|^Mor_/i.test(m)) && (
                    <div className="mb-2 pb-1.5 border-b border-violet-500/30 space-y-1">
                      <div className="text-[10px] font-medium text-violet-300">폼 / 바디 변형 Morph</div>
                      {filteredMorphs
                        .filter((m) => /^S_(1[2-9]|[2-9]\d)|^Mor_/i.test(m))
                        .map((mName) => {
                          const val = manualMorphOverrides[mName] ?? 0;
                          return (
                            <div key={`body_${mName}`} className="flex items-center gap-2 text-[10px]">
                              <span className="w-28 truncate text-violet-300 font-mono" title={mName}>
                                {mName}
                              </span>
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.02}
                                value={val}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  setManualMorphOverrides((prev) => ({ ...prev, [mName]: v }));
                                }}
                                className="flex-1 accent-violet-400 h-1"
                              />
                              <span className="w-7 text-right font-mono text-violet-300">{val.toFixed(1)}</span>
                            </div>
                          );
                        })}
                    </div>
                  )}

                  {filteredMorphs
                    .filter((m) => !/^S_(1[2-9]|[2-9]\d)|^Mor_/i.test(m))
                    .slice(0, 60)
                    .map((mName) => {
                      const val = manualMorphOverrides[mName] ?? 0;
                      return (
                        <div key={mName} className="flex items-center gap-2 text-[10px]">
                          <span className="w-28 truncate text-slate-400" title={mName}>
                            {mName}
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.02}
                            value={val}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setManualMorphOverrides((prev) => ({ ...prev, [mName]: v }));
                            }}
                            className="flex-1 accent-cyan-400 h-1"
                          />
                          <span className="w-7 text-right font-mono text-slate-400">{val.toFixed(1)}</span>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: CUTSCENES */}
          {activeTab === 'cutscene' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="p-2.5 border-b border-slate-800/80 space-y-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
                  <input
                    type="text"
                    value={cutsceneSearch}
                    onChange={(e) => setCutsceneSearch(e.target.value)}
                    placeholder="컷신 검색 (D0001, DrawCard, Story...)"
                    className="w-full bg-slate-900 border border-slate-800 rounded pl-8 pr-2 py-1 text-xs"
                  />
                </div>

                <div className="flex flex-wrap gap-1">
                  {['', 'DrawCard', 'MainStory', 'RoleQuest', 'Combat', 'Other'].map((cat) => (
                    <button
                      key={cat || 'ALL'}
                      onClick={() => setCutsceneCategory(cat)}
                      className={`px-1.5 py-0.5 rounded text-[10px] border ${
                        cutsceneCategory === cat
                          ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      {cat || '전체'}
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cutsceneFilterByChar}
                    onChange={(e) => setCutsceneFilterByChar(e.target.checked)}
                    className="accent-amber-400"
                  />
                  선택 캐릭터 ({selectedChar?.name ?? '-'}) 관련 컷신만 보기
                </label>

                {activeCutscene && (
                  <div className="bg-slate-900/90 border border-slate-800 rounded-md p-2 space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-amber-300 truncate">{activeCutscene.name}</span>
                      <span className="text-[10px] text-slate-400">{activeCutscene.duration.toFixed(2)}s</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setCutsceneUseCamera((v) => !v)}
                        className={`flex-1 py-1 rounded text-[11px] border flex items-center justify-center gap-1 ${
                          cutsceneUseCamera
                            ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                            : 'bg-slate-950 border-slate-800 text-slate-400'
                        }`}
                      >
                        <Camera className="w-3 h-3" />
                        {cutsceneUseCamera ? '연출 카메라 추적 ON' : '자유 시점 (Orbit)'}
                      </button>
                      <button
                        onClick={() => setCutsceneMode((m) => !m)}
                        className="px-2 py-1 rounded text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-200"
                      >
                        {cutsceneMode ? '해제' : '재생뷰'}
                      </button>
                    </div>
                    <div className="max-h-24 overflow-y-auto text-[10px] space-y-0.5 pt-1 border-t border-slate-800">
                      {activeCutscene.actors.slice(0, 20).map((a) => (
                        <div key={a.guid} className="flex justify-between text-slate-400">
                          <span className="truncate">{a.isCamera ? `🎥 ${a.name}` : a.name}</span>
                          <span className="shrink-0 ml-1">
                            {a.animSections.length > 0 ? `A:${a.animSections.length}` : ''}
                            {a.transformTracks.length > 0 ? ` T:${a.transformTracks.length}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-800/40 min-h-0">
                {cutsceneList.map((cs, idx) => {
                  const active = activeCutscene?.path === cs.path && cutsceneMode;
                  return (
                    <button
                      key={`${cs.path}-${idx}`}
                      onClick={() => handleSelectCutscene(cs)}
                      className={`w-full text-left px-3 py-2 hover:bg-slate-800/50 transition ${
                        active ? 'bg-amber-500/15 border-l-2 border-l-amber-400' : ''
                      }`}
                    >
                      <div className={`text-xs truncate ${active ? 'text-amber-300 font-medium' : 'text-slate-200'}`}>
                        {cs.name}
                      </div>
                      <div className="text-[10px] text-slate-500 flex items-center gap-1.5">
                        <span>{cs.category}</span>
                        {cs.characterHint && <span className="text-cyan-400">· {cs.characterHint}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: PHYSICS & INTERACTIVE SPHERE COLLISION */}
          {activeTab === 'physics' && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
              <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={physicsRuntime.enabled}
                      onChange={(e) => setPhysicsRuntime((p) => ({ ...p, enabled: e.target.checked }))}
                      className="accent-emerald-400"
                    />
                    <span>KawaiiPhysics 실시간 물리 적용</span>
                  </label>
                  <button
                    onClick={() => setPhysicsResetSeq((s) => s + 1)}
                    className="px-2 py-0.5 rounded text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1"
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                    리셋
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <label className="flex items-center gap-1.5 cursor-pointer text-cyan-300">
                    <input
                      type="checkbox"
                      checked={physicsRuntime.showChains}
                      onChange={(e) => setPhysicsRuntime((p) => ({ ...p, showChains: e.target.checked }))}
                      className="accent-cyan-400"
                    />
                    본 체인 시각화
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-amber-300">
                    <input
                      type="checkbox"
                      checked={physicsRuntime.showColliders}
                      onChange={(e) => setPhysicsRuntime((p) => ({ ...p, showColliders: e.target.checked }))}
                      className="accent-amber-400"
                    />
                    내부 캡슐 콜라이더
                  </label>
                </div>

                <div className="space-y-1.5 pt-1 text-[11px]">
                  {(
                    [
                      ['강성 (Stiffness)', 'stiffnessScale', 0.1, 3.0, 0.05],
                      ['감쇠 (Damping)', 'dampingScale', 0.1, 3.0, 0.05],
                      ['중력 (Gravity)', 'gravityScale', 0.0, 3.0, 0.05],
                      ['바람 세기 (Wind)', 'windStrength', 0.0, 2.0, 0.05],
                      ['구체 반발력 (Bounce)', 'sphereBounciness', 0.0, 1.0, 0.05]
                    ] as const
                  ).map(([label, key, min, max, step]) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className="w-32 text-slate-400">{label}</span>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={physicsRuntime[key]}
                        onChange={(e) =>
                          setPhysicsRuntime((prev) => ({ ...prev, [key]: Number(e.target.value) }))
                        }
                        className="flex-1 accent-emerald-400 h-1"
                      />
                      <span className="w-9 text-right font-mono text-slate-300">
                        {physicsRuntime[key].toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* INTERACTIVE SPHERE COLLIDER MANIPULATOR */}
              <div className="bg-slate-900/90 border border-cyan-500/30 rounded-lg p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-cyan-300 flex items-center gap-1.5">
                    <Box className="w-3.5 h-3.5" />
                    인터랙티브 구체 충돌 (Sphere)
                  </span>
                  <button
                    onClick={addSphere}
                    className="px-2 py-0.5 rounded text-[10px] bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" />
                    구체 추가
                  </button>
                </div>

                <p className="text-[10px] text-slate-400 leading-relaxed">
                  3D 뷰에서 구체를 클릭하거나 아래에서 선택하면 X/Y/Z 기즈모 화살표로 직접 드래그하여 머리카락/치마/리본과 실시간 충돌시킬 수 있습니다.
                </p>

                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] text-emerald-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sphereAutoOrbit}
                      onChange={(e) => setSphereAutoOrbit(e.target.checked)}
                      className="accent-emerald-400"
                    />
                    자동 회전 충돌 테스트 (Auto-Orbit)
                  </label>
                  {selectedSphereId && (
                    <button
                      onClick={() => setSelectedSphereId(null)}
                      className="text-[10px] text-slate-400 hover:text-white"
                    >
                      기즈모 숨김
                    </button>
                  )}
                </div>

                <div className="space-y-1">
                  {spheres.map((s) => {
                    const active = s.id === selectedSphereId;
                    return (
                      <div
                        key={s.id}
                        className={`flex items-center justify-between px-2 py-1 rounded border text-[11px] cursor-pointer ${
                          active
                            ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-200'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300'
                        }`}
                        onClick={() => setSelectedSphereId(s.id)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <input
                            type="checkbox"
                            checked={s.enabled}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) =>
                              setSpheres((prev) =>
                                prev.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x))
                              )
                            }
                            className="accent-cyan-400"
                          />
                          <span className="truncate">{s.name}</span>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSpheres((prev) => prev.filter((x) => x.id !== s.id));
                            if (selectedSphereId === s.id) setSelectedSphereId(null);
                          }}
                          className="text-slate-500 hover:text-rose-400 p-0.5"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>

                {selectedSphere && (
                  <div className="pt-2 border-t border-slate-800/80 space-y-1.5 text-[11px]">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-slate-400">빠른 배치 프리셋</span>
                      <div className="flex gap-1">
                        {(
                          [
                            ['치마/허리', [0.0, 0.72, 0.22]],
                            ['머리카락', [0.16, 1.32, 0.14]],
                            ['가슴 앞', [0.0, 1.15, 0.22]]
                          ] as [string, [number, number, number]][]
                        ).map(([lbl, p]) => (
                          <button
                            key={lbl}
                            onClick={() => handleUpdateSpherePos(selectedSphere.id, p)}
                            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px]"
                          >
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>

                    {(['X', 'Y', 'Z'] as const).map((axis, idx) => (
                      <div key={axis} className="flex items-center gap-2">
                        <span className="w-12 text-slate-400">위치 {axis}</span>
                        <input
                          type="range"
                          min={idx === 1 ? 0.05 : -1.2}
                          max={idx === 1 ? 2.2 : 1.2}
                          step={0.01}
                          value={selectedSphere.position[idx]}
                          onChange={(e) => {
                            const next: [number, number, number] = [...selectedSphere.position];
                            next[idx] = Number(e.target.value);
                            handleUpdateSpherePos(selectedSphere.id, next);
                          }}
                          className="flex-1 accent-cyan-400 h-1"
                        />
                        <span className="w-11 text-right font-mono text-slate-300">
                          {selectedSphere.position[idx].toFixed(2)}
                        </span>
                      </div>
                    ))}

                    <div className="flex items-center gap-2">
                      <span className="w-12 text-slate-400">반지름</span>
                      <input
                        type="range"
                        min={0.04}
                        max={0.45}
                        step={0.01}
                        value={selectedSphere.radius}
                        onChange={(e) => {
                          const r = Number(e.target.value);
                          setSpheres((prev) =>
                            prev.map((x) => (x.id === selectedSphere.id ? { ...x, radius: r } : x))
                          );
                        }}
                        className="flex-1 accent-cyan-400 h-1"
                      />
                      <span className="w-11 text-right font-mono text-slate-300">
                        {selectedSphere.radius.toFixed(2)}m
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Loaded KawaiiPhysics Groups */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 space-y-1.5">
                <div className="text-xs font-medium text-slate-300">
                  KawaiiPhysics 본 그룹 ({physicsConfig?.groups.length ?? 0})
                </div>
                {physicsConfig?.sourceAbp && (
                  <div className="text-[10px] text-slate-500 truncate">{physicsConfig.sourceAbp}</div>
                )}
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {physicsConfig?.groups.map((g, i) => (
                    <div key={`${g.name}-${i}`} className="bg-slate-950/70 border border-slate-800/80 rounded p-1.5 text-[10px]">
                      <div className="flex justify-between text-slate-200 font-medium">
                        <span>{g.name}</span>
                        <span className="text-emerald-400">S:{g.settings.stiffness.toFixed(2)} D:{g.settings.damping.toFixed(2)}</span>
                      </div>
                      <div className="text-slate-400 truncate mt-0.5">
                        루트: {g.rootBones.join(', ')}
                      </div>
                      <div className="text-slate-500 mt-0.5">
                        캡슐 {g.capsuleLimits.length} · 구체 {g.sphericalLimits.length} · 평면 {g.planarLimits.length}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: SHADER & MATERIALS */}
          {activeTab === 'shader' && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
              <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 space-y-2 text-[11px]">
                <div className="text-xs font-medium text-amber-300">명조 Toon 셰이더 & 라이트 설정</div>

                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ['wuwa-toon', '명조 커스텀 Toon'],
                      ['pbr', '표준 PBR'],
                      ['flat-albedo', 'Flat Albedo'],
                      ['wireframe', 'Wireframe']
                    ] as [ShaderRenderMode, string][]
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      onClick={() => setShaderMode(m)}
                      className={`py-1.5 rounded border text-center transition ${
                        shaderMode === m
                          ? 'bg-amber-500/20 border-amber-500/50 text-amber-300 font-medium'
                          : 'bg-slate-950 border-slate-800 text-slate-400'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="pt-1 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-300 flex items-center gap-1.5">
                      {showOutlines ? <Eye className="w-3.5 h-3.5 text-cyan-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                      Inverted-Hull 외곽선 (_OL)
                    </span>
                    <button
                      onClick={() => setShowOutlines((v) => !v)}
                      className={`px-2 py-0.5 rounded text-[10px] border ${
                        showOutlines ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300' : 'bg-slate-800 border-slate-700 text-slate-400'
                      }`}
                    >
                      {showOutlines ? '켜짐' : '꺼짐'}
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="w-28 text-slate-400">외곽선 두께</span>
                    <input
                      type="range"
                      min={0}
                      max={3}
                      step={0.05}
                      value={outlineWidthScale}
                      onChange={(e) => setOutlineWidthScale(Number(e.target.value))}
                      className="flex-1 accent-cyan-400 h-1"
                    />
                    <span className="w-9 text-right font-mono">{outlineWidthScale.toFixed(2)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="w-28 text-slate-400">얼굴 SDF 오프셋</span>
                    <input
                      type="range"
                      min={-0.5}
                      max={0.5}
                      step={0.01}
                      value={sdfOffset}
                      onChange={(e) => setSdfOffset(Number(e.target.value))}
                      className="flex-1 accent-amber-400 h-1"
                    />
                    <span className="w-9 text-right font-mono">{sdfOffset.toFixed(2)}</span>
                  </div>

                  <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                    <input
                      type="checkbox"
                      checked={sdfFlipX}
                      onChange={(e) => setSdfFlipX(e.target.checked)}
                      className="accent-amber-400"
                    />
                    얼굴 SDF 좌우 미러링 (Flip X)
                  </label>

                  <div className="flex items-center gap-2">
                    <span className="w-28 text-slate-400">툰 명암 대비</span>
                    <input
                      type="range"
                      min={0.3}
                      max={1.8}
                      step={0.05}
                      value={toonContrast}
                      onChange={(e) => setToonContrast(Number(e.target.value))}
                      className="flex-1 accent-amber-400 h-1"
                    />
                    <span className="w-9 text-right font-mono">{toonContrast.toFixed(2)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="w-28 text-slate-400">조명 방위각 (°)</span>
                    <input
                      type="range"
                      min={-180}
                      max={180}
                      step={1}
                      value={lightAzimuth}
                      onChange={(e) => setLightAzimuth(Number(e.target.value))}
                      className="flex-1 accent-amber-400 h-1"
                    />
                    <span className="w-9 text-right font-mono">{lightAzimuth}°</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="w-28 text-slate-400">조명 고도각 (°)</span>
                    <input
                      type="range"
                      min={-45}
                      max={89}
                      step={1}
                      value={lightElevation}
                      onChange={(e) => setLightElevation(Number(e.target.value))}
                      className="flex-1 accent-amber-400 h-1"
                    />
                    <span className="w-9 text-right font-mono">{lightElevation}°</span>
                  </div>
                </div>
              </div>

              {/* Wetness & Wet-Alpha Control Panel */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 space-y-2.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                    <Droplets className="w-3.5 h-3.5 text-sky-400" />
                    젖음 / 반투명 (Wet &amp; Alpha)
                  </div>
                  <span className="text-[10px] font-mono text-sky-300">
                    {Math.round(wetness * 100)}%
                  </span>
                </div>

                {manifest && (
                  <div
                    className={`px-2 py-1.5 rounded border text-[10px] leading-snug ${
                      wetAlphaSummary.hasWaterCloth || wetAlphaSummary.hasBlendWater
                        ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-200'
                        : wetAlphaSummary.hasWetOverlayMI
                          ? 'bg-sky-500/10 border-sky-500/40 text-sky-200'
                          : wetAlphaSummary.wetAlphaSlotCount > 0
                            ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-200'
                            : 'bg-slate-950/80 border-slate-800 text-slate-400'
                    }`}
                  >
                    {wetAlphaSummary.hasWaterCloth
                      ? `WaterCloth 보유 (${wetAlphaSummary.wetAlphaSlotCount}슬롯) — 수분 디졸브·투과 지원`
                      : wetAlphaSummary.hasBlendWater
                        ? `BlendWater · 반투명 ${wetAlphaSummary.wetAlphaSlotCount}슬롯 — 수중 투과·젖음 알파 지원`
                        : wetAlphaSummary.hasWetOverlayMI
                          ? `Wet/* 전용 셰이더 보유 · wet-alpha ${wetAlphaSummary.wetAlphaSlotCount}슬롯`
                          : wetAlphaSummary.wetAlphaSlotCount > 0
                            ? `반투명 의상 ${wetAlphaSummary.wetAlphaSlotCount}슬롯 — 젖음 알파 변화 지원`
                            : '불투명 의상 위주 — 표면 젖음·광택만 적용 (알파 변화 없음)'}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    onClick={() => setWetness(0)}
                    className={`py-1 rounded border text-[10px] transition ${
                      wetness <= 0.01
                        ? 'bg-sky-500/20 border-sky-500/60 text-sky-200 font-medium'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    건조 0%
                  </button>
                  <button
                    onClick={() => {
                      setWetness(0.45);
                      setWetAlpha((v) => (v < 0.2 ? 0.85 : v));
                    }}
                    className={`py-1 rounded border text-[10px] transition ${
                      wetness > 0.01 && wetness < 0.75
                        ? 'bg-sky-500/20 border-sky-500/60 text-sky-200 font-medium'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    촉촉함 45%
                  </button>
                  <button
                    onClick={() => {
                      setWetness(1.0);
                      setWetAlpha(1.0);
                    }}
                    className={`py-1 rounded border text-[10px] transition ${
                      wetness >= 0.75
                        ? 'bg-sky-500/20 border-sky-500/60 text-sky-200 font-medium'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    폭우 100%
                  </button>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-28 text-slate-400">젖음 강도</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={wetness}
                      onChange={(e) => setWetness(Number(e.target.value))}
                      className="flex-1 accent-sky-400 h-1"
                    />
                    <span className="w-9 text-right font-mono">{wetness.toFixed(2)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`w-28 ${
                        wetAlphaSummary.wetAlphaSlotCount > 0 ? 'text-slate-400' : 'text-slate-600'
                      }`}
                      title="WetOverlay / WaterCloth / 반투명 의상 슬롯에만 적용됩니다"
                    >
                      젖음 알파 변화
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={wetAlpha}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setWetAlpha(v);
                        if (v > 0.02 && wetness <= 0.01 && wetAlphaSummary.wetAlphaSlotCount > 0) {
                          setWetness(0.65);
                        }
                      }}
                      className="flex-1 accent-cyan-400 h-1"
                    />
                    <span className="w-9 text-right font-mono">{wetAlpha.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Material Slot Inspector */}
              {manifest && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 space-y-1.5">
                  <div className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-cyan-400" />
                    머티리얼 섹션 ({manifest.sections.length})
                  </div>
                  <div className="space-y-1.5">
                    {manifest.sections.map((sec) => {
                      const baseSlot = manifest.materials[sec.materialIndex];
                      const slot =
                        baseSlot && effectiveMaterialOverrides
                          ? (effectiveMaterialOverrides[baseSlot.name] ??
                            effectiveMaterialOverrides[`MI_${baseSlot.name}`] ??
                            baseSlot)
                          : baseSlot;
                      const slotTags = getSlotWetAlphaTags(slot);
                      const ol = sec.outlineMaterialIndex != null ? manifest.materials[sec.outlineMaterialIndex] : null;
                      return (
                        <div
                          key={`${sec.sectionIndex}-${sec.materialName}`}
                          className="bg-slate-950/70 border border-slate-800 rounded p-2 text-[10px]"
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-medium text-slate-200 truncate">
                              #{sec.sectionIndex} {slot?.name ?? sec.materialName}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-amber-300 shrink-0 ml-1">
                              {slot?.shaderType ?? 'Standard'}
                            </span>
                          </div>
                          {slotTags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {slotTags.map((tag) => (
                                <span
                                  key={tag}
                                  className={`px-1 py-0.2 rounded text-[9px] border ${
                                    tag === 'WaterCloth' || tag === 'WetMI'
                                      ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                                      : tag === 'WetAlpha' || tag === 'Glass' || tag === 'Translucent'
                                        ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                                        : 'bg-slate-800 border-slate-700 text-slate-300'
                                  }`}
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="text-slate-500 mt-0.5 flex flex-wrap gap-2">
                            <span>Tri: {sec.numTriangles}</span>
                            {ol && <span className="text-cyan-400">OL: {ol.name}</span>}
                            {sec.disabled && <span className="text-rose-400">Disabled</span>}
                          </div>
                          {slot && (
                            <div className="text-slate-500 truncate mt-0.5">
                              Tex: {Object.keys(slot.textures).join(', ') || 'None'}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

export default App;

