import * as THREE from 'three';
import type {
  AnimationPayloadDto,
  AnimBoneTrackDto,
  AnimFloatCurveDto,
  AnimSegmentPayloadDto,
  CutsceneFloatChannelDto,
  CutsceneTransformTrackDto
} from '../types';

export interface RigTarget {
  bonesByName: Map<string, THREE.Bone[]>;
  meshesWithMorphs: THREE.Mesh[];
}

export function captureRestPose(root: THREE.Object3D): RigTarget {
  const bonesByName = new Map<string, THREE.Bone[]>();
  const meshesWithMorphs: THREE.Mesh[] = [];

  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      const b = obj as THREE.Bone;
      b.userData.restPos = b.position.clone();
      b.userData.restQuat = b.quaternion.clone();
      b.userData.restScale = b.scale.clone();

      const key = b.name.toLowerCase();
      const arr = bonesByName.get(key);
      if (arr) {
        if (!arr.includes(b)) arr.push(b);
      } else {
        bonesByName.set(key, [b]);
      }
    }
    if ((obj as THREE.Mesh).isMesh) {
      const m = obj as THREE.Mesh;
      if (m.morphTargetDictionary && m.morphTargetInfluences) {
        meshesWithMorphs.push(m);
      }
    }
  });

  return { bonesByName, meshesWithMorphs };
}

export function resetToRestPose(rig: RigTarget): void {
  for (const bones of rig.bonesByName.values()) {
    for (const b of bones) {
      if (b.userData.restPos) b.position.copy(b.userData.restPos);
      if (b.userData.restQuat) b.quaternion.copy(b.userData.restQuat);
      if (b.userData.restScale) b.scale.copy(b.userData.restScale);
    }
  }
  for (const m of rig.meshesWithMorphs) {
    if (m.morphTargetInfluences) m.morphTargetInfluences.fill(0);
  }
}

const _keyQ0 = new THREE.Quaternion();
const _keyQ1 = new THREE.Quaternion();
const _keyV0 = new THREE.Vector3();
const _keyV1 = new THREE.Vector3();
const _outQuat = new THREE.Quaternion();
const _outPos = new THREE.Vector3();
const _outScale = new THREE.Vector3();

function isRootOrPelvis(boneName: string): boolean {
  const n = boneName.toLowerCase();
  return n === 'root' || n === 'bip001' || n === 'bip001pelvis' || n === 'pelvis';
}

function isCoreSkeletonBone(boneName: string): boolean {
  const n = boneName.toLowerCase();
  if (n === 'root' || n === 'pelvis' || n === 'bip001' || n === 'bip001pelvis') return true;
  if (
    n.startsWith('bip001spine') ||
    n.startsWith('bip001neck') ||
    n.startsWith('bip001head') ||
    n.startsWith('bip001l') ||
    n.startsWith('bip001r') ||
    n.startsWith('bip001_l_') ||
    n.startsWith('bip001_r_') ||
    n.startsWith('bip001_shoulder') ||
    n.startsWith('ik_') ||
    n.startsWith('vb_')
  ) {
    return !isSecondaryName(n);
  }
  return false;
}

function evalVec3Keys(keys: number[], alphaIndex: number, out: THREE.Vector3, fallback?: THREE.Vector3): boolean {
  const count = Math.floor(keys.length / 3);
  if (count === 0) return false;
  if (count === 1) {
    const x = keys[0], y = keys[1], z = keys[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      if (fallback) out.copy(fallback);
      return false;
    }
    out.set(x, y, z);
    return true;
  }
  const f = THREE.MathUtils.clamp(alphaIndex, 0, count - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(i0 + 1, count - 1);
  const t = f - i0;
  _keyV0.set(keys[i0 * 3], keys[i0 * 3 + 1], keys[i0 * 3 + 2]);
  _keyV1.set(keys[i1 * 3], keys[i1 * 3 + 1], keys[i1 * 3 + 2]);
  if (!Number.isFinite(_keyV0.x) || !Number.isFinite(_keyV0.y) || !Number.isFinite(_keyV0.z)) {
    if (fallback) out.copy(fallback);
    return false;
  }
  if (!Number.isFinite(_keyV1.x) || !Number.isFinite(_keyV1.y) || !Number.isFinite(_keyV1.z)) {
    out.copy(_keyV0);
    return true;
  }
  out.lerpVectors(_keyV0, _keyV1, t);
  return true;
}

function evalQuatKeys(keys: number[], alphaIndex: number, out: THREE.Quaternion): boolean {
  const count = Math.floor(keys.length / 4);
  if (count === 0) return false;
  if (count === 1) {
    _keyQ0.set(keys[0], keys[1], keys[2], keys[3]);
    if (!Number.isFinite(_keyQ0.x) || !Number.isFinite(_keyQ0.y) || !Number.isFinite(_keyQ0.z) || !Number.isFinite(_keyQ0.w) || _keyQ0.lengthSq() < 1e-10) {
      return false;
    }
    out.copy(_keyQ0).normalize();
    return true;
  }
  const f = THREE.MathUtils.clamp(alphaIndex, 0, count - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(i0 + 1, count - 1);
  const t = f - i0;
  _keyQ0.set(keys[i0 * 4], keys[i0 * 4 + 1], keys[i0 * 4 + 2], keys[i0 * 4 + 3]);
  _keyQ1.set(keys[i1 * 4], keys[i1 * 4 + 1], keys[i1 * 4 + 2], keys[i1 * 4 + 3]);
  if (!Number.isFinite(_keyQ0.x) || _keyQ0.lengthSq() < 1e-10) return false;
  _keyQ0.normalize();
  if (!Number.isFinite(_keyQ1.x) || _keyQ1.lengthSq() < 1e-10) {
    out.copy(_keyQ0);
    return true;
  }
  _keyQ1.normalize();
  if (_keyQ0.dot(_keyQ1) < 0) _keyQ1.set(-_keyQ1.x, -_keyQ1.y, -_keyQ1.z, -_keyQ1.w);
  out.slerpQuaternions(_keyQ0, _keyQ1, t).normalize();
  return true;
}

export function evalFloatCurve(curve: AnimFloatCurveDto, timeSec: number): number {
  const { times, values } = curve;
  if (times.length === 0) return 0;
  if (timeSec <= times[0]) return values[0];
  const last = times.length - 1;
  if (timeSec >= times[last]) return values[last];

  let lo = 0;
  let hi = last;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= timeSec) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const alpha = span > 1e-6 ? (timeSec - times[lo]) / span : 0;
  return values[lo] + (values[hi] - values[lo]) * alpha;
}

function findActiveSegment(segments: AnimSegmentPayloadDto[], timeSec: number): { seg: AnimSegmentPayloadDto; localTime: number } | null {
  if (segments.length === 0) return null;
  if (segments.length === 1) {
    const s = segments[0];
    const len = s.sourceLength > 1e-5 ? s.sourceLength : Math.max(0.01, s.endTime - s.startTime);
    return { seg: s, localTime: THREE.MathUtils.clamp(timeSec * (s.playRate || 1), 0, len) };
  }

  for (const s of segments) {
    if (timeSec >= s.startTime && timeSec <= s.endTime + 1e-4) {
      const len = s.sourceLength > 1e-5 ? s.sourceLength : Math.max(0.01, s.endTime - s.startTime);
      const raw = (timeSec - s.startTime) * (s.playRate || 1);
      return { seg: s, localTime: s.loopingCount > 1 ? raw % len : THREE.MathUtils.clamp(raw, 0, len) };
    }
  }
  const last = segments[segments.length - 1];
  return { seg: last, localTime: last.sourceLength };
}

function applyTrackList(
  rig: RigTarget,
  tracks: AnimBoneTrackDto[],
  seg: AnimSegmentPayloadDto,
  localTime: number,
  retargetTranslation: boolean,
  includeRootMotion: boolean,
  isOverlayLayer: boolean
): void {
  const len = seg.sourceLength > 1e-5 ? seg.sourceLength : 1;
  const u = THREE.MathUtils.clamp(localTime / len, 0, 1);

  for (const tr of tracks) {
    if (isOverlayLayer) {
      if (isCoreSkeletonBone(tr.boneName)) continue;
      if (!tr.hasExplicitTrack && !isSecondaryName(tr.boneName)) continue;
    }

    const bones = rig.bonesByName.get(tr.boneName.toLowerCase());
    if (!bones || bones.length === 0) continue;

    const qCount = Math.floor(tr.quatKeys.length / 4);
    const pCount = Math.floor(tr.posKeys.length / 3);
    const sCount = Math.floor(tr.scaleKeys.length / 3);

    const isRoot = isRootOrPelvis(tr.boneName);
    const wantPos = pCount > 0 && (
      !retargetTranslation ||
      tr.translationMode === 'Animation' ||
      tr.translationMode === 'AnimationScaled' ||
      isRoot
    );

    const hasQuat = qCount > 0 && evalQuatKeys(tr.quatKeys, u * Math.max(1, qCount - 1), _outQuat);
    const applyPos = wantPos && evalVec3Keys(tr.posKeys, u * Math.max(1, pCount - 1), _outPos);
    const hasScale = sCount > 0 && evalVec3Keys(tr.scaleKeys, u * Math.max(1, sCount - 1), _outScale);

    for (const bone of bones) {
      if (hasQuat) bone.quaternion.copy(_outQuat);
      if (applyPos) {
        if (!includeRootMotion && tr.boneName.toLowerCase() === 'root') {
          if (bone.userData.restPos) bone.position.copy(bone.userData.restPos);
        } else {
          bone.position.copy(_outPos);
        }
      } else if (bone.userData.restPos && !isOverlayLayer) {
        bone.position.copy(bone.userData.restPos);
      }
      if (hasScale && Math.abs(_outScale.x) > 1e-4 && Math.abs(_outScale.y) > 1e-4 && Math.abs(_outScale.z) > 1e-4) {
        bone.scale.copy(_outScale);
      } else if (bone.userData.restScale && !isOverlayLayer) {
        bone.scale.copy(bone.userData.restScale);
      }
    }
  }
}

function isSecondaryName(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('hair') || n.includes('skirt') || n.includes('piao') || n.includes('rib') ||
         n.includes('fadai') || n.includes('cloth') || n.includes('cape') || n.includes('tail') || n.includes('dress');
}

export function evaluateAnimationFrame(
  rig: RigTarget,
  payload: AnimationPayloadDto,
  timeSec: number,
  options: {
    applyRibbonLayer: boolean;
    applyFacialCurves: boolean;
    retargetTranslation: boolean;
    includeRootMotion: boolean;
    manualMorphOverrides: Record<string, number>;
  }
): Record<string, number> {
  const active = findActiveSegment(payload.segments, timeSec);
  const activeCurves: Record<string, number> = {};

  if (active) {
    applyTrackList(
      rig,
      active.seg.tracks,
      active.seg,
      active.localTime,
      options.retargetTranslation,
      options.includeRootMotion,
      false
    );

    if (options.applyFacialCurves) {
      for (const c of active.seg.curves) {
        activeCurves[c.name] = evalFloatCurve(c, active.localTime);
      }
    }
  }

  // Layer 2: Additive/Ribbon track (`Rib_*`)
  if (options.applyRibbonLayer && payload.ribbonLayer) {
    const ribActive = findActiveSegment(payload.ribbonLayer.segments, timeSec);
    if (ribActive) {
      applyTrackList(
        rig,
        ribActive.seg.tracks,
        ribActive.seg,
        ribActive.localTime,
        options.retargetTranslation,
        options.includeRootMotion,
        true
      );
    }
  }

  // Apply Morph Targets (facial curves + manual overrides)
  for (const mesh of rig.meshesWithMorphs) {
    const dict = mesh.morphTargetDictionary;
    const inf = mesh.morphTargetInfluences;
    if (!dict || !inf) continue;

    inf.fill(0);
    if (options.applyFacialCurves) {
      let lowerMap = mesh.userData.morphLowerMap as Map<string, number> | undefined;
      if (!lowerMap) {
        lowerMap = new Map<string, number>();
        for (const [mName, idx] of Object.entries(dict)) {
          lowerMap.set(mName.toLowerCase(), idx);
        }
        mesh.userData.morphLowerMap = lowerMap;
      }
      for (const [cName, val] of Object.entries(activeCurves)) {
        if (!Number.isFinite(val)) continue;
        const idx = dict[cName] ?? lowerMap.get(cName.toLowerCase());
        if (idx !== undefined) {
          inf[idx] = THREE.MathUtils.clamp(val, -0.25, 1.25);
        }
      }
    }

    for (const [mName, val] of Object.entries(options.manualMorphOverrides)) {
      if (Number.isFinite(val) && val !== 0 && dict[mName] !== undefined) {
        inf[dict[mName]] = THREE.MathUtils.clamp(inf[dict[mName]] + val, 0, 1.5);
      }
    }
  }

  return activeCurves;
}

export function evalChannel(ch: CutsceneFloatChannelDto, timeSec: number): number {
  const { times, values, defaultValue } = ch;
  if (times.length === 0) return defaultValue;
  if (timeSec <= times[0]) return values[0];
  const last = times.length - 1;
  if (timeSec >= times[last]) return values[last];
  let lo = 0;
  let hi = last;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= timeSec) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const a = span > 1e-6 ? (timeSec - times[lo]) / span : 0;
  return values[lo] + (values[hi] - values[lo]) * a;
}

export function applyCutsceneActorTransform(
  obj: THREE.Object3D,
  tracks: CutsceneTransformTrackDto[],
  timeSec: number,
  isCamera = false
): void {
  const active = tracks.find((t) => {
    const endT = t.endTime > t.startTime + 1e-4
      ? t.endTime
      : Math.max(t.startTime, t.tx.times[t.tx.times.length - 1] ?? 0, t.rx.times[t.rx.times.length - 1] ?? 0);
    return timeSec >= t.startTime - 1e-4 && timeSec <= endT + 1e-4;
  }) ?? tracks[0];
  if (!active) return;

  // UE X,Y,Z cm -> Y-up X,Z,Y (server already scaled cm -> m by 0.01)
  const ux = evalChannel(active.tx, timeSec);
  const uy = evalChannel(active.ty, timeSec);
  const uz = evalChannel(active.tz, timeSec);
  obj.position.set(ux, uz, uy);

  // UE FRotator (Roll=X, Pitch=Y, Yaw=Z in deg) exact Quaternion formula (matches UE/CUE4Parse FRotator::Quaternion),
  // then SwapYZ(qx, qz, qy, -qw) into Three.js Y-up right-handed space.
  const rollHalf = THREE.MathUtils.degToRad(evalChannel(active.rx, timeSec)) * 0.5;
  const pitchHalf = THREE.MathUtils.degToRad(evalChannel(active.ry, timeSec)) * 0.5;
  const yawHalf = THREE.MathUtils.degToRad(evalChannel(active.rz, timeSec)) * 0.5;
  const sr = Math.sin(rollHalf), cr = Math.cos(rollHalf);
  const sp = Math.sin(pitchHalf), cp = Math.cos(pitchHalf);
  const sy = Math.sin(yawHalf), cy = Math.cos(yawHalf);
  const qUeX = cr * sp * sy - sr * cp * cy;
  const qUeY = -cr * sp * cy - sr * cp * sy;
  const qUeZ = cr * cp * sy - sr * sp * cy;
  const qUeW = cr * cp * cy + sr * sp * sy;
  obj.quaternion.set(qUeX, qUeZ, qUeY, -qUeW).normalize();

  if (isCamera) {
    // UE camera looks along +X; Three.js camera looks along -Z (rotate +Y -90 deg in Three)
    const camFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    obj.quaternion.multiply(camFix);
  } else {
    const sx = evalChannel(active.sx, timeSec);
    const sy = evalChannel(active.sy, timeSec);
    const sz = evalChannel(active.sz, timeSec);
    obj.scale.set(sx || 1, sz || 1, sy || 1);
  }
}

