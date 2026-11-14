import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { api } from '../api';
import {
  applyCutsceneActorTransform,
  captureRestPose,
  evalChannel,
  evaluateAnimationFrame,
  resetToRestPose,
  type RigTarget
} from '../animation/AnimationEngine';
import { KawaiiPhysicsSolver } from '../physics/KawaiiPhysicsSolver';
import {
  buildMaterialListForManifest,
  createSharedToonUniforms,
  createWuWaMaterialForSection,
  type ToonRuntimeUniforms
} from '../shaders/wuwaShaders';
import type {
  AnimationPayloadDto,
  CharacterVariantDto,
  CutsceneActorDto,
  CutsceneDetailDto,
  InteractiveSphereDto,
  MaterialSlotDto,
  MeshSectionDto,
  ModelFormMaterialsDto,
  ModelManifestDto,
  PhysicsConfigDto,
  PhysicsRuntimeOptions,
  ShaderRenderMode,
  SocketDto,
  WeaponSummaryDto
} from '../types';

export interface WuWaViewportProps {
  characterVariant: CharacterVariantDto | null;
  activePrimaryMeshOverride?: string | null;
  formMaterials?: ModelFormMaterialsDto | null;
  activeMaterialPresetTag?: string | null;
  enabledExtraParts: string[];
  equippedWeapon: WeaponSummaryDto | null;
  weaponAttachBone: string;
  activeAnimation: AnimationPayloadDto | null;
  animTime: number;
  isPlaying: boolean;
  animSpeed: number;
  animLoop: boolean;
  applyRibbonLayer: boolean;
  applyFacialCurves: boolean;
  retargetTranslation: boolean;
  includeRootMotion: boolean;
  manualMorphOverrides: Record<string, number>;
  onAnimTimeChange: (t: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onMorphTargetsLoaded: (morphs: string[]) => void;
  onBonesLoaded: (bones: string[], sockets: SocketDto[]) => void;
  onActiveCurvesSampled?: (curves: Record<string, number>) => void;
  onPhysicsReady?: (groupCount: number, nodeCount: number) => void;
  onManifestLoaded?: (manifest: ModelManifestDto | null) => void;
  onLoadingChange?: (loading: boolean, error: string | null) => void;

  physicsConfig: PhysicsConfigDto | null;
  physicsRuntime: PhysicsRuntimeOptions;
  physicsResetSignal: number;
  spheres: InteractiveSphereDto[];
  selectedSphereId: string | null;
  sphereAutoOrbit: boolean;
  onSelectSphere: (id: string | null) => void;
  onUpdateSpherePos: (id: string, pos: [number, number, number]) => void;

  shaderMode: ShaderRenderMode;
  showOutlines: boolean;
  outlineWidthScale: number;
  sdfOffset: number;
  sdfFlipX: boolean;
  toonContrast: number;
  wetness: number;
  wetAlpha: number;
  lightAzimuth: number;
  lightElevation: number;

  activeCutscene: CutsceneDetailDto | null;
  cutsceneMode: boolean;
  cutsceneTime: number;
  cutscenePlaying: boolean;
  cutsceneUseCamera: boolean;
  cutsceneSpeed: number;
  cutsceneLoop: boolean;
  onCutsceneTimeChange: (t: number) => void;
  onCutsceneStatusChange?: (status: { loading: boolean; loadedActors: number; totalActors: number; loadedAnims: number }) => void;

  cameraPresetSignal: { preset: 'full' | 'face' | 'side' | 'back'; seq: number };
}

interface LoadedMeshEntry {
  mesh: THREE.Mesh;
  sec: MeshSectionDto | undefined;
  slot: MaterialSlotDto | undefined;
  rawSlot?: MaterialSlotDto | undefined;
  outlineSlot: MaterialSlotDto | undefined;
  outlineMesh: THREE.SkinnedMesh | THREE.Mesh | null;
}

function resolveMaterialSlotOverride(
  entries: LoadedMeshEntry[],
  formMaterials: ModelFormMaterialsDto | null | undefined,
  activeTag: string | null | undefined
): void {
  const preset = activeTag && formMaterials
    ? formMaterials.presets.find((p) => p.tag.toLowerCase() === activeTag.toLowerCase())
    : undefined;
  const overrides = preset?.slotOverrides;
  const lowerMap = new Map<string, MaterialSlotDto>();
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      lowerMap.set(k.toLowerCase(), v);
    }
  }

  for (const e of entries) {
    const baseSlot = e.rawSlot ?? e.slot;
    e.rawSlot = baseSlot;
    if (lowerMap.size === 0) {
      e.slot = baseSlot;
      continue;
    }
    const key1 = baseSlot?.name?.toLowerCase() ?? '';
    const key2 = e.sec?.materialName?.toLowerCase() ?? '';
    e.slot = lowerMap.get(key1) ?? lowerMap.get(key2) ?? baseSlot;
  }
}

interface CutsceneLoadedActor {
  dto: CutsceneActorDto;
  root: THREE.Object3D;
  rig: RigTarget | null;
  camera: THREE.PerspectiveCamera | null;
  cameraHelper: THREE.Group | null;
}

const gltfLoader = new GLTFLoader();

function loadGlb(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => reject(err instanceof Error ? err : new Error('Failed to load GLB'))
    );
  });
}

function matchMeshSections(
  sceneRoot: THREE.Object3D,
  manifest: ModelManifestDto
): { mesh: THREE.Mesh; sec: MeshSectionDto | undefined; slot: MaterialSlotDto | undefined; outlineSlot: MaterialSlotDto | undefined }[] {
  const entries = buildMaterialListForManifest(manifest);
  const enabledEntries = entries.filter((e) => !e.sec.disabled);

  const rawMeshes: THREE.Mesh[] = [];
  sceneRoot.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && !obj.userData.isOutlinePass) {
      rawMeshes.push(obj as THREE.Mesh);
    }
  });

  const usedIdx = new Set<number>();
  return rawMeshes.map((mesh, i) => {
    const origMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const matName = origMat?.name ?? '';

    let matched = entries.find((e, idx) => {
      if (usedIdx.has(idx)) return false;
      return (
        !e.sec.disabled &&
        matName.length > 0 &&
        (e.sec.materialName.toLowerCase() === matName.toLowerCase() || e.slot?.name.toLowerCase() === matName.toLowerCase())
      );
    });

    if (!matched && matName.length > 0) {
      matched = entries.find((e, idx) => {
        if (usedIdx.has(idx)) return false;
        return e.sec.materialName.toLowerCase() === matName.toLowerCase() || e.slot?.name.toLowerCase() === matName.toLowerCase();
      });
    }

    if (!matched) {
      matched = rawMeshes.length === enabledEntries.length ? enabledEntries[i] : entries[i];
    }

    if (matched) {
      const mIdx = entries.indexOf(matched);
      if (mIdx >= 0) usedIdx.add(mIdx);
    }

    return {
      mesh,
      sec: matched?.sec,
      slot: matched?.slot,
      outlineSlot: matched?.outlineSlot
    };
  });
}

async function applyMaterialsToEntries(
  entries: LoadedMeshEntry[],
  mode: ShaderRenderMode,
  showOutlines: boolean,
  sharedUniforms: ToonRuntimeUniforms,
  isCancelled: () => boolean
): Promise<void> {
  // Remove previous outlines
  for (const e of entries) {
    if (e.outlineMesh && e.outlineMesh.parent) {
      e.outlineMesh.parent.remove(e.outlineMesh);
      if (Array.isArray(e.outlineMesh.material)) {
        e.outlineMesh.material.forEach((m) => m.dispose());
      } else {
        e.outlineMesh.material.dispose();
      }
      e.outlineMesh = null;
    }
  }

  await Promise.all(
    entries.map(async (entry) => {
      const { mesh, sec, slot, outlineSlot } = entry;
      mesh.frustumCulled = false;

      // Skip disabled, outline, face shadow, and screen-distortion proxy sections
      const slotNameL = slot?.name?.toLowerCase() ?? '';
      const parentNameL = slot?.parentName?.toLowerCase() ?? '';
      const hasMainTex = Boolean(slot?.textures && (slot.textures['MainTex'] || slot.textures['BaseColor'] || slot.textures['Diffuse']));
      const isHiddenProxy =
        Boolean(sec?.disabled) ||
        slot?.shaderType === 'Outline' ||
        slot?.shaderType === 'FaceShadow' ||
        slot?.shaderType === 'Distortion' ||
        slotNameL.includes('faceshadow') ||
        parentNameL.includes('faceshadow') ||
        slotNameL.endsWith('_shadow') ||
        parentNameL.includes('distortion') ||
        ((slotNameL.endsWith('_fx') || slotNameL.includes('fx_')) && !hasMainTex);

      if (isHiddenProxy) {
        mesh.visible = false;
        return;
      }

      const { mainMat, outlineMat } = await createWuWaMaterialForSection(mesh, slot, outlineSlot, mode, sharedUniforms);
      if (isCancelled()) return;

      const oldMat = mesh.material;
      mesh.material = mainMat;
      mesh.visible = true;
      const isFurCard = Boolean(mainMat.userData?.useFurCard);
      mesh.renderOrder = mainMat.transparent && !mainMat.depthWrite ? 1 : 0;
      mesh.castShadow = !isFurCard && (sec?.castShadow ?? true);
      mesh.receiveShadow = !isFurCard;

      if (oldMat && !Array.isArray(oldMat) && oldMat.userData?.isWuWaManaged) {
        oldMat.dispose();
      }
      mainMat.userData.isWuWaManaged = true;

      if (outlineMat && mode === 'wuwa-toon') {
        let olMesh: THREE.SkinnedMesh | THREE.Mesh;
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
          const sk = mesh as THREE.SkinnedMesh;
          const olSk = new THREE.SkinnedMesh(sk.geometry, outlineMat);
          olSk.bind(sk.skeleton, sk.bindMatrix);
          olSk.morphTargetDictionary = sk.morphTargetDictionary;
          olSk.morphTargetInfluences = sk.morphTargetInfluences;
          olMesh = olSk;
        } else {
          olMesh = new THREE.Mesh(mesh.geometry, outlineMat);
        }
        olMesh.name = `${mesh.name}_Outline`;
        olMesh.userData.isOutlinePass = true;
        olMesh.frustumCulled = false;
        olMesh.visible = showOutlines;
        olMesh.renderOrder = 2;
        mesh.parent?.add(olMesh);
        entry.outlineMesh = olMesh;
      }
    })
  );
}

function calibrateHeadBasis(rig: RigTarget): {
  restForward: THREE.Vector3;
  restRight: THREE.Vector3;
  headBone: THREE.Bone | null;
  headLocalForward: THREE.Vector3;
  headLocalRight: THREE.Vector3;
} {
  let leftBone: THREE.Bone | null = null;
  let rightBone: THREE.Bone | null = null;
  let headBone: THREE.Bone | null = null;

  for (const [k, list] of rig.bonesByName.entries()) {
    if (!headBone && (k === 'bip001head' || k === 'head')) headBone = list[0];
    if (!leftBone && (k === 'bip001lupperarm' || k === 'bip001lclavicle')) leftBone = list[0];
    if (!rightBone && (k === 'bip001rupperarm' || k === 'bip001rclavicle')) rightBone = list[0];
  }
  if (!headBone) {
    for (const [k, list] of rig.bonesByName.entries()) {
      if (k.includes('head')) {
        headBone = list[0];
        break;
      }
    }
  }

  const restForward = new THREE.Vector3(0, 0, 1);
  const restRight = new THREE.Vector3(-1, 0, 0);

  if (leftBone && rightBone) {
    const pL = leftBone.getWorldPosition(new THREE.Vector3());
    const pR = rightBone.getWorldPosition(new THREE.Vector3());
    const rightVec = new THREE.Vector3().subVectors(pR, pL);
    rightVec.y = 0;
    if (rightVec.lengthSq() > 1e-6) {
      restRight.copy(rightVec).normalize();
      // Right-hand cross: (pL - pR) x Up(+Y) = -restRight x +Y = front facing direction
      const leftVec = restRight.clone().negate();
      restForward.crossVectors(leftVec, new THREE.Vector3(0, 1, 0)).normalize();
    }
  }

  const headLocalForward = restForward.clone();
  const headLocalRight = restRight.clone();
  if (headBone) {
    headBone.updateMatrixWorld(true);
    const invQ = headBone.getWorldQuaternion(new THREE.Quaternion()).invert();
    headLocalForward.applyQuaternion(invQ).normalize();
    headLocalRight.applyQuaternion(invQ).normalize();
  }

  return { restForward, restRight, headBone, headLocalForward, headLocalRight };
}

export const WuWaViewport: React.FC<WuWaViewportProps> = (props) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Latest props ref for rAF loop
  const propsRef = useRef(props);
  propsRef.current = props;

  // Scene refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const viewCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
  const transformRef = useRef<TransformControls | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  const sharedUniformsRef = useRef<ToonRuntimeUniforms>(createSharedToonUniforms());
  const charRootRef = useRef<THREE.Group | null>(null);
  const weaponRootRef = useRef<THREE.Group | null>(null);
  const cutsceneRootRef = useRef<THREE.Group | null>(null);
  const sphereGroupRef = useRef<THREE.Group | null>(null);
  const sphereMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());

  const charMeshEntriesRef = useRef<LoadedMeshEntry[]>([]);
  const weaponMeshEntriesRef = useRef<LoadedMeshEntry[]>([]);
  const primaryRigRef = useRef<RigTarget | null>(null);
  const primarySkeletonRef = useRef<THREE.Skeleton | null>(null);
  const primarySocketsRef = useRef<SocketDto[]>([]);
  const headBasisRef = useRef<ReturnType<typeof calibrateHeadBasis> | null>(null);
  const charBoundsCenterRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0.9, 0));
  const charHeightRef = useRef<number>(1.65);

  const physicsSolverRef = useRef<KawaiiPhysicsSolver>(new KawaiiPhysicsSolver());
  const spheresLiveRef = useRef<InteractiveSphereDto[]>(props.spheres);
  spheresLiveRef.current = props.spheres;

  const cutsceneActorsRef = useRef<CutsceneLoadedActor[]>([]);
  const cutsceneAnimCacheRef = useRef<Map<string, AnimationPayloadDto | null>>(new Map());

  const animTimeRef = useRef<number>(props.animTime);
  animTimeRef.current = props.animTime;
  const cutsceneTimeRef = useRef<number>(props.cutsceneTime);
  cutsceneTimeRef.current = props.cutsceneTime;

  const headWorldQ = useRef(new THREE.Quaternion());
  const tempFwd = useRef(new THREE.Vector3());
  const tempRight = useRef(new THREE.Vector3());

  // 1. Initialize Three.js WebGLRenderer, Scene, Controls, Lights, Grid
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0f17');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      38,
      Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
      0.05,
      200
    );
    camera.position.set(0, 1.15, 2.75);
    viewCameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    rendererRef.current = renderer;

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 0.9, 0);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;
    orbit.minDistance = 0.25;
    orbit.maxDistance = 30;
    orbit.update();
    orbitRef.current = orbit;

    const tc = new TransformControls(camera, renderer.domElement);
    tc.setMode('translate');
    tc.setSize(0.75);
    scene.add(tc.getHelper());
    transformRef.current = tc;

    tc.addEventListener('dragging-changed', (ev) => {
      orbit.enabled = !(ev as unknown as { value: boolean }).value;
    });

    tc.addEventListener('objectChange', () => {
      const obj = tc.object;
      if (!obj) return;
      const id = obj.userData.sphereId as string | undefined;
      if (!id) return;
      const nextPos: [number, number, number] = [
        Number(obj.position.x.toFixed(3)),
        Number(obj.position.y.toFixed(3)),
        Number(obj.position.z.toFixed(3))
      ];
      spheresLiveRef.current = spheresLiveRef.current.map((s) => (s.id === id ? { ...s, position: nextPos } : s));
      propsRef.current.onUpdateSpherePos(id, nextPos);
    });

    // Click to select physics sphere
    const raycaster = new THREE.Raycaster();
    const ptrDown = new THREE.Vector2();
    const onPointerDown = (e: PointerEvent) => {
      ptrDown.set(e.clientX, e.clientY);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (tc.dragging) return;
      const dx = e.clientX - ptrDown.x;
      const dy = e.clientY - ptrDown.y;
      if (dx * dx + dy * dy > 25) return;

      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      const targets = Array.from(sphereMeshesRef.current.values()).filter((m) => m.visible);
      const hits = raycaster.intersectObjects(targets, false);
      if (hits.length > 0) {
        const hitId = hits[0].object.userData.sphereId as string | undefined;
        if (hitId) propsRef.current.onSelectSphere(hitId);
      }
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    // Studio Grid + Lighting (used by PBR mode & ground reference)
    const grid = new THREE.GridHelper(12, 24, '#334155', '#1e293b');
    grid.position.y = 0;
    scene.add(grid);

    const floorGeo = new THREE.CircleGeometry(6, 48);
    const floorMat = new THREE.MeshStandardMaterial({
      color: '#0f1623',
      roughness: 0.9,
      metalness: 0.1
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.002;
    floor.receiveShadow = true;
    scene.add(floor);

    const hemi = new THREE.HemisphereLight('#dbeafe', '#1e293b', 1.1);
    scene.add(hemi);

    const dirLight = new THREE.DirectionalLight('#fff7ed', 2.0);
    dirLight.position.set(2.5, 4.2, 3.0);
    dirLight.target.position.set(0, 0.9, 0);
    scene.add(dirLight.target);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.left = -2.2;
    dirLight.shadow.camera.right = 2.2;
    dirLight.shadow.camera.top = 2.2;
    dirLight.shadow.camera.bottom = -2.2;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 16;
    dirLight.shadow.bias = -0.0004;
    dirLight.shadow.normalBias = 0.015;
    scene.add(dirLight);

    const rimLight = new THREE.DirectionalLight('#93c5fd', 0.9);
    rimLight.position.set(-2.5, 2.2, -3.0);
    scene.add(rimLight);

    // Container groups
    const charRoot = new THREE.Group();
    charRoot.name = 'WuWaCharacterRoot';
    scene.add(charRoot);
    charRootRef.current = charRoot;

    const weaponRoot = new THREE.Group();
    weaponRoot.name = 'WuWaWeaponRoot';
    weaponRootRef.current = weaponRoot;

    const cutsceneRoot = new THREE.Group();
    cutsceneRoot.name = 'WuWaCutsceneRoot';
    cutsceneRoot.visible = false;
    scene.add(cutsceneRoot);
    cutsceneRootRef.current = cutsceneRoot;

    const sphereGroup = new THREE.Group();
    sphereGroup.name = 'WuWaInteractiveSpheres';
    scene.add(sphereGroup);
    sphereGroupRef.current = sphereGroup;

    scene.add(physicsSolverRef.current.debugGroup);

    // Resize handling
    const ro = new ResizeObserver(() => {
      if (!container) return;
      const w = Math.max(container.clientWidth, 1);
      const h = Math.max(container.clientHeight, 1);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    // Animation / Render Loop
    let rafId = 0;
    let lastNow = performance.now();
    let lastCurveSampleMs = 0;

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      const dt = Math.min((now - lastNow) / 1000, 0.05);
      lastNow = now;

      const p = propsRef.current;

      // Update light direction uniform
      const az = THREE.MathUtils.degToRad(p.lightAzimuth);
      const el = THREE.MathUtils.degToRad(p.lightElevation);
      const cosEl = Math.cos(el);
      sharedUniformsRef.current.uLightDir.value
        .set(cosEl * Math.sin(az), Math.sin(el), cosEl * Math.cos(az))
        .normalize();
      sharedUniformsRef.current.uOutlineWidthScale.value = p.outlineWidthScale;
      sharedUniformsRef.current.uSdfOffset.value = p.sdfOffset;
      sharedUniformsRef.current.uSdfFlipX.value = p.sdfFlipX ? 1.0 : -1.0;
      sharedUniformsRef.current.uToonContrast.value = p.toonContrast;
      sharedUniformsRef.current.uWetness.value = p.wetness;
      sharedUniformsRef.current.uWetAlpha.value = p.wetAlpha;
      sharedUniformsRef.current.uWetTime.value =
        (sharedUniformsRef.current.uWetTime.value + dt * (p.wetness > 0.001 ? 0.7 + 1.3 * p.wetness : 0.45)) % 1000;
      dirLight.position.copy(sharedUniformsRef.current.uLightDir.value).multiplyScalar(5);

      // Update interactive sphere auto-orbit sweep if enabled
      if (p.sphereAutoOrbit && spheresLiveRef.current.length > 0 && !tc.dragging) {
        const targetId = p.selectedSphereId ?? spheresLiveRef.current[0].id;
        const targetMesh = sphereMeshesRef.current.get(targetId);
        const sDto = spheresLiveRef.current.find((s) => s.id === targetId);
        if (targetMesh && sDto) {
          const tOrbit = now * 0.0022;
          const ox = Math.sin(tOrbit) * 0.42;
          const oz = 0.04 + Math.cos(tOrbit * 0.7) * 0.22;
          const oy = sDto.position[1];
          targetMesh.position.set(ox, oy, oz);
          spheresLiveRef.current = spheresLiveRef.current.map((s) =>
            s.id === targetId ? { ...s, position: [ox, oy, oz] } : s
          );
        }
      }

      if (p.cutsceneMode && p.activeCutscene) {
        charRoot.visible = false;
        cutsceneRoot.visible = true;
        sphereGroup.visible = false;
        physicsSolverRef.current.debugGroup.visible = false;
        tc.getHelper().visible = false;

        let curCutTime = cutsceneTimeRef.current;
        if (p.cutscenePlaying && p.activeCutscene.duration > 0) {
          curCutTime += dt * p.cutsceneSpeed;
          if (curCutTime >= p.activeCutscene.duration) {
            curCutTime = p.cutsceneLoop ? curCutTime % p.activeCutscene.duration : p.activeCutscene.duration;
          }
          cutsceneTimeRef.current = curCutTime;
          p.onCutsceneTimeChange(curCutTime);
        }

        // Evaluate all loaded cutscene actors
        let activeCam: THREE.PerspectiveCamera | null = null;
        const cut = p.activeCutscene.cameraCuts.find(
          (c) => curCutTime >= c.startTime - 1e-4 && curCutTime <= c.endTime + 1e-4
        );

        for (const actor of cutsceneActorsRef.current) {
          if (actor.dto.isCamera && actor.camera) {
            if (actor.dto.transformTracks.length > 0) {
              applyCutsceneActorTransform(actor.root, actor.dto.transformTracks, curCutTime, true);
            }
            if (actor.dto.cameraFovTracks.length > 0) {
              const fov = evalChannel(actor.dto.cameraFovTracks[0], curCutTime);
              if (fov > 5 && fov < 140) {
                actor.camera.fov = fov;
                actor.camera.aspect = camera.aspect;
                actor.camera.updateProjectionMatrix();
              }
            }
            if (cut && actor.dto.guid.toLowerCase() === cut.cameraGuid.toLowerCase()) {
              activeCam = actor.camera;
            } else if (!activeCam) {
              activeCam = actor.camera;
            }
            if (actor.cameraHelper) {
              actor.cameraHelper.visible = !p.cutsceneUseCamera;
            }
          } else {
            if (actor.dto.transformTracks.length > 0) {
              applyCutsceneActorTransform(actor.root, actor.dto.transformTracks, curCutTime, false);
            }
            if (actor.rig && actor.dto.animSections.length > 0) {
              const sec =
                actor.dto.animSections.find((s) => curCutTime >= s.startTime - 1e-4 && curCutTime <= s.endTime + 1e-4) ??
                null;
              if (sec) {
                const payload = cutsceneAnimCacheRef.current.get(sec.animPath);
                if (payload) {
                  let localT = (curCutTime - sec.startTime) * (sec.playRate || 1) + (sec.startFrameOffset || 0);
                  if (sec.loop && payload.duration > 0) localT = localT % payload.duration;
                  resetToRestPose(actor.rig);
                  evaluateAnimationFrame(actor.rig, payload, localT, {
                    applyRibbonLayer: true,
                    applyFacialCurves: true,
                    retargetTranslation: true,
                    includeRootMotion: false,
                    manualMorphOverrides: {}
                  });
                }
              }
            }
          }
        }

        // Update Head SDF basis using first hero character actor if present
        const heroActor = cutsceneActorsRef.current.find((a) => !a.dto.isCamera && a.rig);
        if (heroActor?.rig) {
          const b = calibrateHeadBasis(heroActor.rig);
          if (b.headBone) {
            b.headBone.updateMatrixWorld(true);
            b.headBone.getWorldQuaternion(headWorldQ.current);
            sharedUniformsRef.current.uHeadForward.value.copy(b.headLocalForward).applyQuaternion(headWorldQ.current).normalize();
            sharedUniformsRef.current.uHeadRight.value.copy(b.headLocalRight).applyQuaternion(headWorldQ.current).normalize();
          }
        }

        const renderCam = p.cutsceneUseCamera && activeCam ? activeCam : camera;
        if (renderCam === activeCam && activeCam) {
          activeCam.aspect = camera.aspect;
          activeCam.updateProjectionMatrix();
        } else {
          orbit.update();
        }
        renderer.render(scene, renderCam);
      } else {
        charRoot.visible = true;
        cutsceneRoot.visible = false;
        sphereGroup.visible = true;
        const selMesh = p.selectedSphereId ? sphereMeshesRef.current.get(p.selectedSphereId) : null;
        tc.getHelper().visible = Boolean(selMesh && selMesh.visible);

        const rig = primaryRigRef.current;
        if (rig) {
          // Advance animation time if playing
          let curT = animTimeRef.current;
          if (p.activeAnimation && p.isPlaying && p.activeAnimation.duration > 0) {
            curT += dt * p.animSpeed;
            if (curT >= p.activeAnimation.duration) {
              if (p.animLoop) {
                curT = curT % p.activeAnimation.duration;
              } else {
                curT = p.activeAnimation.duration;
                p.onPlayingChange?.(false);
              }
            }
            animTimeRef.current = curT;
            p.onAnimTimeChange(curT);
          }

          // 1. Reset to Rest Pose -> Evaluate Animation (+ Ribbon + Morphs)
          resetToRestPose(rig);
          if (p.activeAnimation) {
            const activeCurves = evaluateAnimationFrame(rig, p.activeAnimation, curT, {
              applyRibbonLayer: p.applyRibbonLayer,
              applyFacialCurves: p.applyFacialCurves,
              retargetTranslation: p.retargetTranslation,
              includeRootMotion: p.includeRootMotion,
              manualMorphOverrides: p.manualMorphOverrides
            });
            if (now - lastCurveSampleMs > 80) {
              lastCurveSampleMs = now;
              p.onActiveCurvesSampled?.(activeCurves);
            }
          } else if (Object.keys(p.manualMorphOverrides).length > 0) {
            for (const mesh of rig.meshesWithMorphs) {
              const dict = mesh.morphTargetDictionary;
              const inf = mesh.morphTargetInfluences;
              if (!dict || !inf) continue;
              for (const [mName, val] of Object.entries(p.manualMorphOverrides)) {
                if (dict[mName] !== undefined) inf[dict[mName]] = val;
              }
            }
          }

          // 2. Step KawaiiPhysics on animated pose + interactive sphere collisions!
          if (p.physicsRuntime.enabled) {
            physicsSolverRef.current.step(dt, charRoot, p.physicsRuntime, spheresLiveRef.current);
          } else {
            physicsSolverRef.current.debugGroup.visible = false;
          }

          // 3. Update Head SDF uniforms for Face shader
          const hb = headBasisRef.current;
          if (hb?.headBone) {
            hb.headBone.updateMatrixWorld(true);
            hb.headBone.getWorldQuaternion(headWorldQ.current);
            sharedUniformsRef.current.uHeadForward.value
              .copy(tempFwd.current.copy(hb.headLocalForward).applyQuaternion(headWorldQ.current))
              .normalize();
            sharedUniformsRef.current.uHeadRight.value
              .copy(tempRight.current.copy(hb.headLocalRight).applyQuaternion(headWorldQ.current))
              .normalize();
          }
        }

        orbit.update();
        renderer.render(scene, camera);
      }
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      tc.detach();
      tc.dispose();
      for (const mesh of sphereMeshesRef.current.values()) {
        mesh.traverse((child) => {
          const m = child as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
          if (Array.isArray(m.material)) m.material.forEach((mt) => mt.dispose());
          else if (m.material) m.material.dispose();
        });
      }
      sphereMeshesRef.current.clear();
      orbit.dispose();
      renderer.dispose();
    };
  }, []);

  // 2. Sync Interactive Sphere Meshes + TransformControls attachment
  useEffect(() => {
    const sphereGroup = sphereGroupRef.current;
    const tc = transformRef.current;
    if (!sphereGroup || !tc) return;

    const keepIds = new Set(props.spheres.map((s) => s.id));
    for (const [id, mesh] of sphereMeshesRef.current.entries()) {
      if (!keepIds.has(id)) {
        if (tc.object === mesh) tc.detach();
        sphereGroup.remove(mesh);
        mesh.traverse((child) => {
          const m = child as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
          if (Array.isArray(m.material)) m.material.forEach((mt) => mt.dispose());
          else if (m.material) m.material.dispose();
        });
        sphereMeshesRef.current.delete(id);
      }
    }

    for (const s of props.spheres) {
      let mesh = sphereMeshesRef.current.get(s.id);
      const isSelected = s.id === props.selectedSphereId;
      if (!mesh) {
        const geo = new THREE.SphereGeometry(1, 24, 18);
        const mat = new THREE.MeshBasicMaterial({
          color: isSelected ? '#22d3ee' : '#34d399',
          wireframe: true,
          transparent: true,
          opacity: isSelected ? 0.85 : 0.45
        });
        mesh = new THREE.Mesh(geo, mat);
        mesh.userData.sphereId = s.id;

        // Inner semi-transparent fill so raycast & visual sphere volume are unmistakable
        const inner = new THREE.Mesh(
          new THREE.SphereGeometry(0.98, 20, 14),
          new THREE.MeshBasicMaterial({
            color: isSelected ? '#06b6d4' : '#10b981',
            transparent: true,
            opacity: isSelected ? 0.22 : 0.1,
            depthWrite: false
          })
        );
        inner.userData.sphereId = s.id;
        mesh.add(inner);

        sphereGroup.add(mesh);
        sphereMeshesRef.current.set(s.id, mesh);
      } else if (mesh.parent !== sphereGroup) {
        sphereGroup.add(mesh);
      }

      if (!props.sphereAutoOrbit || !isSelected) {
        mesh.position.set(s.position[0], s.position[1], s.position[2]);
      }
      mesh.scale.setScalar(Math.max(s.radius, 0.02));
      mesh.visible = s.enabled;

      const outerMat = mesh.material as THREE.MeshBasicMaterial;
      outerMat.color.set(isSelected ? '#22d3ee' : '#34d399');
      outerMat.opacity = isSelected ? 0.85 : 0.45;
    }

    const selMesh = props.selectedSphereId ? sphereMeshesRef.current.get(props.selectedSphereId) : null;
    if (selMesh && selMesh.visible) {
      tc.attach(selMesh);
    } else {
      tc.detach();
    }
  }, [props.spheres, props.selectedSphereId, props.sphereAutoOrbit]);

  // 3. Load Character Variant (+ Enabled Extra Parts)
  useEffect(() => {
    const charRoot = charRootRef.current;
    if (!charRoot || !props.characterVariant) return;

    let cancelled = false;
    const variant = props.characterVariant;

    const run = async () => {
      propsRef.current.onLoadingChange?.(true, null);

      // Clear previous character meshes cleanly
      while (charRoot.children.length > 0) {
        const c = charRoot.children[0];
        charRoot.remove(c);
      }
      charMeshEntriesRef.current = [];
      primaryRigRef.current = null;
      primarySkeletonRef.current = null;

      const effectivePrimaryPath = props.activePrimaryMeshOverride || variant.primaryMeshPath;
      try {
        const manifest = await api.modelManifest(effectivePrimaryPath);
        if (cancelled) return;
        propsRef.current.onManifestLoaded?.(manifest);

        const primaryScene = await loadGlb(manifest.glbUrl);
        if (cancelled) return;
        charRoot.add(primaryScene);
        primaryScene.updateMatrixWorld(true);

        // Index primary bones before mounting socketed props/modular parts
        const primaryBoneMap = new Map<string, THREE.Bone>();
        primaryScene.traverse((obj) => {
          const b = obj as THREE.Bone;
          if (b.isBone && b.name) {
            const key = b.name.toLowerCase();
            if (!primaryBoneMap.has(key)) primaryBoneMap.set(key, b);
          }
        });

        const entries: LoadedMeshEntry[] = matchMeshSections(primaryScene, manifest).map((e) => ({
          ...e,
          rawSlot: e.slot,
          outlineMesh: null
        }));

        // Optional enabled extraParts (Modular parts via MasterPose + Socketed combat/form Props)
        const activeExtras = variant.extraParts.filter((ep) => props.enabledExtraParts.includes(ep.componentName));
        for (const ep of activeExtras) {
          try {
            const epManifest = await api.modelManifest(ep.meshPath);
            if (cancelled) return;
            const epScene = await loadGlb(epManifest.glbUrl);
            if (cancelled) return;

            let mountParent: THREE.Object3D = charRoot;
            const sockName = ep.attachSocket && ep.attachSocket.toLowerCase() !== 'none' ? ep.attachSocket : null;
            if (sockName && sockName.toLowerCase() !== 'root') {
              const matchedSocket = manifest.sockets.find((s) => s.name.toLowerCase() === sockName.toLowerCase());
              const boneKey = (matchedSocket ? matchedSocket.boneName : sockName).toLowerCase();
              const targetBone = primaryBoneMap.get(boneKey);
              if (targetBone) {
                const socketHolder = new THREE.Group();
                socketHolder.name = `Socket_${ep.componentName}`;
                const hasRelPos = Boolean(ep.relativePosition && ep.relativePosition.length >= 3);
                const hasRelQuat = Boolean(ep.relativeQuaternion && ep.relativeQuaternion.length >= 4);
                if (matchedSocket) {
                  socketHolder.position.set(matchedSocket.position[0], matchedSocket.position[1], matchedSocket.position[2]);
                  socketHolder.quaternion.set(
                    matchedSocket.quaternion[0],
                    matchedSocket.quaternion[1],
                    matchedSocket.quaternion[2],
                    matchedSocket.quaternion[3]
                  );
                  socketHolder.scale.set(
                    matchedSocket.scale[0] || 1,
                    matchedSocket.scale[1] || 1,
                    matchedSocket.scale[2] || 1
                  );
                } else if (!hasRelPos && !hasRelQuat) {
                  // Detect props/wings authored in character-world T-pose coordinates (e.g. EDarkNanzhuWingMd10011 at Y~1.0m)
                  // vs socket-local props (centered near origin). Cancel bind-pose bone matrix so they align with character pose
                  // while still tracking targetBone animation deltas.
                  epScene.updateMatrixWorld(true);
                  const epBox = new THREE.Box3().setFromObject(epScene);
                  const epCenter = epBox.isEmpty() ? new THREE.Vector3() : epBox.getCenter(new THREE.Vector3());
                  let rootChildBonePosLen = 0;
                  epScene.traverse((obj) => {
                    if (rootChildBonePosLen === 0 && (obj as THREE.Bone).isBone && obj.name.toLowerCase() !== 'root') {
                      rootChildBonePosLen = obj.position.length();
                    }
                  });
                  if (epCenter.y > 0.45 || rootChildBonePosLen > 0.45) {
                    charRoot.updateMatrixWorld(true);
                    const invCharWorld = charRoot.matrixWorld.clone().invert();
                    const boneRelChar = invCharWorld.multiply(targetBone.matrixWorld);
                    const invBone = boneRelChar.invert();
                    invBone.decompose(socketHolder.position, socketHolder.quaternion, socketHolder.scale);
                  }
                }
                if (hasRelPos) {
                  epScene.position.set(ep.relativePosition![0], ep.relativePosition![1], ep.relativePosition![2]);
                }
                if (hasRelQuat) {
                  epScene.quaternion.set(
                    ep.relativeQuaternion![0],
                    ep.relativeQuaternion![1],
                    ep.relativeQuaternion![2],
                    ep.relativeQuaternion![3]
                  );
                }
                if (ep.relativeScale && ep.relativeScale.length >= 3) {
                  epScene.scale.set(
                    ep.relativeScale[0] || 1,
                    ep.relativeScale[1] || 1,
                    ep.relativeScale[2] || 1
                  );
                }
                socketHolder.add(epScene);
                targetBone.add(socketHolder);
                mountParent = socketHolder;
              }
            }

            if (mountParent === charRoot) {
              // Avoid UE CollisionCylinder half-height offset; only apply CharacterMesh0-relative transforms
              if (ep.attachParent && ep.attachParent.toLowerCase().includes('charactermesh')) {
                if (ep.relativePosition && ep.relativePosition.length >= 3) {
                  epScene.position.set(ep.relativePosition[0], ep.relativePosition[1], ep.relativePosition[2]);
                }
                if (ep.relativeQuaternion && ep.relativeQuaternion.length >= 4) {
                  epScene.quaternion.set(
                    ep.relativeQuaternion[0],
                    ep.relativeQuaternion[1],
                    ep.relativeQuaternion[2],
                    ep.relativeQuaternion[3]
                  );
                }
                if (ep.relativeScale && ep.relativeScale.length >= 3) {
                  epScene.scale.set(
                    ep.relativeScale[0] || 1,
                    ep.relativeScale[1] || 1,
                    ep.relativeScale[2] || 1
                  );
                }
              }
              charRoot.add(epScene);
            }

            const epEntries = matchMeshSections(epScene, epManifest).map((e) => {
              const matIdx = e.sec?.materialIndex ?? e.slot?.index;
              const ovSlot =
                matIdx !== undefined && ep.overrideMaterials
                  ? (ep.overrideMaterials[matIdx] ?? (ep.overrideMaterials as Record<string, MaterialSlotDto>)[String(matIdx)])
                  : undefined;
              const effSlot = ovSlot ?? e.slot;
              return {
                ...e,
                slot: effSlot,
                rawSlot: effSlot,
                outlineMesh: null
              };
            });
            entries.push(...epEntries);
          } catch {
            // Skip failed extra part cleanly
          }
        }

        resolveMaterialSlotOverride(entries, propsRef.current.formMaterials, propsRef.current.activeMaterialPresetTag);
        charMeshEntriesRef.current = entries;

        await applyMaterialsToEntries(
          entries,
          propsRef.current.shaderMode,
          propsRef.current.showOutlines,
          sharedUniformsRef.current,
          () => cancelled
        );
        if (cancelled) return;

        // Capture Rig, Skeleton, Morphs, Sockets, Head Basis
        charRoot.updateMatrixWorld(true);
        const rig = captureRestPose(charRoot);
        primaryRigRef.current = rig;
        primarySocketsRef.current = manifest.sockets;

        let mainSkel: THREE.Skeleton | null = null;
        for (const e of entries) {
          if ((e.mesh as THREE.SkinnedMesh).isSkinnedMesh) {
            mainSkel = (e.mesh as THREE.SkinnedMesh).skeleton;
            break;
          }
        }
        primarySkeletonRef.current = mainSkel;

        const allMorphSet = new Set<string>(manifest.morphTargets);
        for (const m of rig.meshesWithMorphs) {
          if (m.morphTargetDictionary) {
            for (const name of Object.keys(m.morphTargetDictionary)) allMorphSet.add(name);
          }
        }
        propsRef.current.onMorphTargetsLoaded(Array.from(allMorphSet));

        const boneNames = Array.from(rig.bonesByName.keys());
        propsRef.current.onBonesLoaded(boneNames, manifest.sockets);

        const hb = calibrateHeadBasis(rig);
        headBasisRef.current = hb;
        sharedUniformsRef.current.uHeadForward.value.copy(hb.restForward);
        sharedUniformsRef.current.uHeadRight.value.copy(hb.restRight);

        // Compute character bounds for smart camera framing
        const box = new THREE.Box3().setFromObject(primaryScene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        charHeightRef.current = Math.max(size.y, 1.0);
        charBoundsCenterRef.current.copy(center);

        if (cameraRefReady(viewCameraRef.current, orbitRef.current)) {
          const dist = Math.max(charHeightRef.current * 1.65, 2.2);
          orbitRef.current!.target.set(center.x, center.y + charHeightRef.current * 0.04, center.z);
          viewCameraRef.current!.position.set(
            center.x + hb.restForward.x * dist,
            center.y + charHeightRef.current * 0.1,
            center.z + hb.restForward.z * dist
          );
          orbitRef.current!.update();
        }

        // Initialize KawaiiPhysics if config already loaded
        if (mainSkel && propsRef.current.physicsConfig) {
          physicsSolverRef.current.init(mainSkel, propsRef.current.physicsConfig, charRoot);
          propsRef.current.onPhysicsReady?.(physicsSolverRef.current.groupCount, physicsSolverRef.current.boneNodeCount);
        }

        propsRef.current.onLoadingChange?.(false, null);
      } catch (err) {
        if (!cancelled) {
          propsRef.current.onLoadingChange?.(false, err instanceof Error ? err.message : 'Failed to load character');
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [
    props.characterVariant?.id,
    props.characterVariant?.primaryMeshPath,
    props.activePrimaryMeshOverride ?? '',
    props.enabledExtraParts.join('|')
  ]);

  // 4. Initialize / Re-init KawaiiPhysics when physicsConfig changes
  useEffect(() => {
    const skel = primarySkeletonRef.current;
    const charRoot = charRootRef.current;
    if (!skel || !charRoot) return;
    physicsSolverRef.current.init(skel, props.physicsConfig, charRoot);
    propsRef.current.onPhysicsReady?.(physicsSolverRef.current.groupCount, physicsSolverRef.current.boneNodeCount);
  }, [props.physicsConfig]);

  // 5. Reset Physics signal
  useEffect(() => {
    const charRoot = charRootRef.current;
    if (charRoot && props.physicsResetSignal > 0) {
      physicsSolverRef.current.reset(charRoot);
    }
  }, [props.physicsResetSignal]);

  // 6. Load & Attach Weapon
  useEffect(() => {
    const weaponRoot = weaponRootRef.current;
    if (!weaponRoot) return;

    let cancelled = false;
    while (weaponRoot.children.length > 0) {
      weaponRoot.remove(weaponRoot.children[0]);
    }
    if (weaponRoot.parent) weaponRoot.parent.remove(weaponRoot);
    weaponMeshEntriesRef.current = [];

    if (!props.equippedWeapon) return;

    const attachWeapon = async () => {
      try {
        const wManifest = await api.modelManifest(props.equippedWeapon!.meshPath);
        if (cancelled) return;
        const wScene = await loadGlb(wManifest.glbUrl);
        if (cancelled) return;

        weaponRoot.position.set(0, 0, 0);
        weaponRoot.quaternion.identity();
        weaponRoot.scale.set(1, 1, 1);
        weaponRoot.add(wScene);

        const entries: LoadedMeshEntry[] = matchMeshSections(wScene, wManifest).map((e) => ({
          ...e,
          outlineMesh: null
        }));
        weaponMeshEntriesRef.current = entries;

        await applyMaterialsToEntries(
          entries,
          propsRef.current.shaderMode,
          propsRef.current.showOutlines,
          sharedUniformsRef.current,
          () => cancelled
        );
        if (cancelled) return;

        const rig = primaryRigRef.current;
        const charRoot = charRootRef.current;
        if (!charRoot) return;

        let targetObj: THREE.Object3D = charRoot;
        const targetKey = props.weaponAttachBone.toLowerCase();
        if (rig) {
          const matchedSocket = primarySocketsRef.current.find((s) => s.name.toLowerCase() === targetKey);
          const boneLookup = (matchedSocket ? matchedSocket.boneName : props.weaponAttachBone).toLowerCase();
          const boneList =
            rig.bonesByName.get(boneLookup) ??
            rig.bonesByName.get('weaponprop01') ??
            rig.bonesByName.get('bip001rhand') ??
            rig.bonesByName.get('r_hand');

          if (boneList && boneList.length > 0) {
            targetObj = boneList[0];
            if (matchedSocket) {
              weaponRoot.position.set(matchedSocket.position[0], matchedSocket.position[1], matchedSocket.position[2]);
              weaponRoot.quaternion.set(
                matchedSocket.quaternion[0],
                matchedSocket.quaternion[1],
                matchedSocket.quaternion[2],
                matchedSocket.quaternion[3]
              );
              weaponRoot.scale.set(matchedSocket.scale[0] || 1, matchedSocket.scale[1] || 1, matchedSocket.scale[2] || 1);
            }
          }
        }
        targetObj.add(weaponRoot);
      } catch {
        // Ignore weapon load errors cleanly
      }
    };

    attachWeapon();
    return () => {
      cancelled = true;
    };
  }, [
    props.equippedWeapon?.meshPath,
    props.weaponAttachBone,
    props.characterVariant?.primaryMeshPath,
    props.activePrimaryMeshOverride ?? '',
    props.enabledExtraParts.join('|')
  ]);

  // 7. Shader Mode Switch (Character + Weapon)
  useEffect(() => {
    let cancelled = false;
    const allEntries = [...charMeshEntriesRef.current, ...weaponMeshEntriesRef.current];
    if (allEntries.length === 0) return;
    resolveMaterialSlotOverride(
      charMeshEntriesRef.current,
      propsRef.current.formMaterials,
      propsRef.current.activeMaterialPresetTag
    );
    applyMaterialsToEntries(
      allEntries,
      props.shaderMode,
      props.showOutlines,
      sharedUniformsRef.current,
      () => cancelled
    );
    return () => {
      cancelled = true;
    };
  }, [props.shaderMode, props.activeMaterialPresetTag, props.formMaterials]);

  // 8. Toggle Outlines visibility without rebuilding shaders
  useEffect(() => {
    const allEntries = [...charMeshEntriesRef.current, ...weaponMeshEntriesRef.current];
    for (const e of allEntries) {
      if (e.outlineMesh) e.outlineMesh.visible = props.showOutlines && props.shaderMode === 'wuwa-toon';
    }
  }, [props.showOutlines, props.shaderMode]);

  // 9. Camera Presets
  useEffect(() => {
    if (props.cameraPresetSignal.seq === 0) return;
    const cam = viewCameraRef.current;
    const orbit = orbitRef.current;
    const hb = headBasisRef.current;
    if (!cam || !orbit) return;

    const c = charBoundsCenterRef.current;
    const h = charHeightRef.current;
    const fwd = hb?.restForward ?? new THREE.Vector3(0, 0, 1);
    const right = hb?.restRight ?? new THREE.Vector3(-1, 0, 0);

    if (props.cameraPresetSignal.preset === 'full') {
      const dist = Math.max(h * 1.65, 2.2);
      orbit.target.set(c.x, c.y + h * 0.04, c.z);
      cam.position.set(c.x + fwd.x * dist, c.y + h * 0.1, c.z + fwd.z * dist);
    } else if (props.cameraPresetSignal.preset === 'face') {
      const headPos = hb?.headBone ? hb.headBone.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(c.x, c.y + h * 0.4, c.z);
      const dist = 0.68;
      orbit.target.set(headPos.x, headPos.y + 0.03, headPos.z);
      cam.position.set(headPos.x + fwd.x * dist, headPos.y + 0.05, headPos.z + fwd.z * dist);
    } else if (props.cameraPresetSignal.preset === 'side') {
      const dist = Math.max(h * 1.5, 2.0);
      orbit.target.set(c.x, c.y, c.z);
      cam.position.set(c.x + right.x * dist, c.y + h * 0.05, c.z + right.z * dist);
    } else if (props.cameraPresetSignal.preset === 'back') {
      const dist = Math.max(h * 1.65, 2.2);
      orbit.target.set(c.x, c.y, c.z);
      cam.position.set(c.x - fwd.x * dist, c.y + h * 0.15, c.z - fwd.z * dist);
    }
    orbit.update();
  }, [props.cameraPresetSignal]);

  // 10. Load Cutscene Scene (Actors, Cameras, AnimSections)
  useEffect(() => {
    const cutsceneRoot = cutsceneRootRef.current;
    if (!cutsceneRoot) return;

    let cancelled = false;
    while (cutsceneRoot.children.length > 0) {
      cutsceneRoot.remove(cutsceneRoot.children[0]);
    }
    cutsceneActorsRef.current = [];
    cutsceneAnimCacheRef.current.clear();
    cutsceneRoot.position.set(0, 0, 0);

    if (!props.activeCutscene) return;

    const loadCutscene = async () => {
      const detail = props.activeCutscene!;
      const candidates = detail.actors.filter((a) => a.isCamera || a.meshPath);
      const capped = candidates.slice(0, 28); // Cap dense background FX actors for responsiveness

      // Center large world-space cutscenes onto the studio grid origin
      const anchorActor = capped.find((a) => !a.isCamera && a.transformTracks.length > 0) ?? capped.find((a) => a.transformTracks.length > 0);
      if (anchorActor) {
        const tr = anchorActor.transformTracks[0];
        const ax = evalChannel(tr.tx, 0);
        const ay = evalChannel(tr.ty, 0);
        const az = evalChannel(tr.tz, 0);
        if (Math.hypot(ax, ay) > 10 || Math.abs(az) > 10) {
          cutsceneRoot.position.set(-ax, -az, -ay);
        }
      }
      let loadedCount = 0;
      let animCount = 0;

      propsRef.current.onCutsceneStatusChange?.({
        loading: true,
        loadedActors: 0,
        totalActors: capped.length,
        loadedAnims: 0
      });

      // Collect unique animPaths across actors
      const uniqueAnimPaths = new Set<string>();
      for (const a of capped) {
        for (const sec of a.animSections) {
          if (sec.animPath) uniqueAnimPaths.add(sec.animPath);
        }
      }

      // Load animations concurrently in batches of 4
      const animList = Array.from(uniqueAnimPaths);
      for (let i = 0; i < animList.length; i += 4) {
        if (cancelled) return;
        const batch = animList.slice(i, i + 4);
        await Promise.all(
          batch.map(async (p) => {
            try {
              const payload = await api.animation(p);
              cutsceneAnimCacheRef.current.set(p, payload);
            } catch {
              cutsceneAnimCacheRef.current.set(p, null);
            }
            animCount++;
          })
        );
        if (!cancelled) {
          propsRef.current.onCutsceneStatusChange?.({
            loading: true,
            loadedActors: loadedCount,
            totalActors: capped.length,
            loadedAnims: animCount
          });
        }
      }

      // Load actors
      for (const actorDto of capped) {
        if (cancelled) return;

        if (actorDto.isCamera) {
          const camRoot = new THREE.Group();
          camRoot.name = `CutCam_${actorDto.name}`;
          const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 500);
          camRoot.add(cam);

          // Small camera wireframe gizmo
          const helper = new THREE.Group();
          const bodyMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.14, 0.1, 0.2),
            new THREE.MeshBasicMaterial({ color: '#f59e0b', wireframe: true })
          );
          helper.add(bodyMesh);
          camRoot.add(helper);
          cutsceneRoot.add(camRoot);

          cutsceneActorsRef.current.push({
            dto: actorDto,
            root: camRoot,
            rig: null,
            camera: cam,
            cameraHelper: helper
          });
          loadedCount++;
          continue;
        }

        if (actorDto.meshPath) {
          try {
            const manifest = await api.modelManifest(actorDto.meshPath);
            if (cancelled) return;
            const modelScene = await loadGlb(manifest.glbUrl);
            if (cancelled) return;

            const wrapper = new THREE.Group();
            wrapper.name = `CutActor_${actorDto.name}`;
            wrapper.add(modelScene);
            cutsceneRoot.add(wrapper);

            const entries: LoadedMeshEntry[] = matchMeshSections(modelScene, manifest).map((e) => ({
              ...e,
              outlineMesh: null
            }));
            await applyMaterialsToEntries(
              entries,
              propsRef.current.shaderMode,
              propsRef.current.showOutlines,
              sharedUniformsRef.current,
              () => cancelled
            );
            if (cancelled) return;

            const rig = captureRestPose(wrapper);
            cutsceneActorsRef.current.push({
              dto: actorDto,
              root: wrapper,
              rig,
              camera: null,
              cameraHelper: null
            });
          } catch {
            // Skip unloadable prop cleanly
          }
        }
        loadedCount++;
        if (!cancelled) {
          propsRef.current.onCutsceneStatusChange?.({
            loading: true,
            loadedActors: loadedCount,
            totalActors: capped.length,
            loadedAnims: animCount
          });
        }
      }

      if (!cancelled) {
        propsRef.current.onCutsceneStatusChange?.({
          loading: false,
          loadedActors: loadedCount,
          totalActors: capped.length,
          loadedAnims: animCount
        });
      }
    };

    loadCutscene();
    return () => {
      cancelled = true;
    };
  }, [props.activeCutscene?.path]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative select-none cursor-grab active:cursor-grabbing"
    />
  );
};

function cameraRefReady(cam: THREE.PerspectiveCamera | null, orbit: OrbitControls | null): boolean {
  return Boolean(cam && orbit);
}

