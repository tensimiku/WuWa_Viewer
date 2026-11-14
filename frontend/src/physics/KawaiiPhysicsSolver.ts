import * as THREE from 'three';
import type {
  InteractiveSphereDto,
  KawaiiCurveSampleDto,
  KawaiiGroupDto,
  PhysicsConfigDto,
  PhysicsRuntimeOptions
} from '../types';

interface SimNode {
  bone: THREE.Bone;
  parentBone: THREE.Object3D | null;
  parentNode: SimNode | null;
  lengthFromParent: number;
  boneLength: number;
  isDummy: boolean;
  isRoot: boolean;
  localRestOffset: THREE.Vector3;
  poseLocalQuat: THREE.Quaternion;
  location: THREE.Vector3;
  prevLocation: THREE.Vector3;
  poseLocation: THREE.Vector3;
  radius: number;
  damping: number;
  stiffness: number;
  worldDampingLocation: number;
  limitAngleRad: number;
  depthRatio: number;
  animatedLocalDir: THREE.Vector3;
}

interface SimGroup {
  config: KawaiiGroupDto;
  nodes: SimNode[];
  capsuleColliders: { bone: THREE.Bone | null; localPos: THREE.Vector3; localQuat: THREE.Quaternion; radius: number; halfLen: number }[];
  sphereColliders: { bone: THREE.Bone | null; localPos: THREE.Vector3; radius: number; limitType: string }[];
  planarColliders: { bone: THREE.Bone | null; localPos: THREE.Vector3; localNormal: THREE.Vector3 }[];
}

function evalCurve(curve: KawaiiCurveSampleDto | null, ratio: number, baseVal: number): number {
  if (!curve || !curve.enabled || curve.times.length === 0) return baseVal;
  const times = curve.times;
  const vals = curve.values;
  if (ratio <= times[0]) return baseVal * vals[0];
  if (ratio >= times[times.length - 1]) return baseVal * vals[vals.length - 1];
  for (let i = 0; i < times.length - 1; i++) {
    if (ratio >= times[i] && ratio <= times[i + 1]) {
      const span = times[i + 1] - times[i];
      const alpha = span > 1e-6 ? (ratio - times[i]) / span : 0;
      return baseVal * (vals[i] + (vals[i + 1] - vals[i]) * alpha);
    }
  }
  return baseVal;
}

export class KawaiiPhysicsSolver {
  private groups: SimGroup[] = [];
  private boneMap = new Map<string, THREE.Bone[]>();
  private elapsed = 0;
  private lastRootPos = new THREE.Vector3();
  private hasLastRootPos = false;

  // Scratch vectors to avoid GC churn per frame (kept strictly separated by role)
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _vRootDelta = new THREE.Vector3();
  private readonly _vPrev = new THREE.Vector3();
  private readonly _vVel = new THREE.Vector3();
  private readonly _capA = new THREE.Vector3();
  private readonly _capB = new THREE.Vector3();
  private readonly _vSphDiff = new THREE.Vector3();
  private readonly _vCurParent = new THREE.Vector3();
  private readonly _vCurChild = new THREE.Vector3();
  private readonly _vAimCur = new THREE.Vector3();
  private readonly _vAimSolved = new THREE.Vector3();
  private readonly _q1 = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _qWorld = new THREE.Quaternion();
  private readonly _qParentWorldInv = new THREE.Quaternion();
  private readonly _qLocalTarget = new THREE.Quaternion();
  private readonly _m1 = new THREE.Matrix4();

  // Debug visualization group
  public readonly debugGroup = new THREE.Group();
  private chainLines: THREE.LineSegments | null = null;
  private colliderDebugMeshes: THREE.Mesh[] = [];

  constructor() {
    this.debugGroup.name = 'KawaiiPhysicsDebug';
  }

  public init(skeleton: THREE.Skeleton, config: PhysicsConfigDto | null, rootObject: THREE.Object3D): void {
    this.clearDebug();
    this.groups = [];
    this.boneMap.clear();
    this.hasLastRootPos = false;

    for (const b of skeleton.bones) {
      const key = b.name.toLowerCase();
      const arr = this.boneMap.get(key) ?? [];
      if (!arr.includes(b)) arr.push(b);
      this.boneMap.set(key, arr);
    }
    rootObject.traverse((obj) => {
      const b = obj as THREE.Bone;
      if (!b.isBone || !b.name) return;
      const key = b.name.toLowerCase();
      const arr = this.boneMap.get(key) ?? [];
      if (!arr.includes(b)) arr.push(b);
      this.boneMap.set(key, arr);
    });

    if (!config || config.groups.length === 0) return;

    rootObject.updateMatrixWorld(true);
    for (const b of skeleton.bones) b.updateMatrixWorld(true);

    for (const gCfg of config.groups) {
      const excludeSet = new Set(gCfg.excludeBones.map((x) => x.toLowerCase()));
      const nodes: SimNode[] = [];

      for (const rootName of gCfg.rootBones) {
        const rootBone = this.findBone(rootName);
        if (!rootBone || excludeSet.has(rootBone.name.toLowerCase())) continue;

        // Collect BFS/DFS depth first so we know maxDepth for curves
        const branch: { bone: THREE.Bone; parentIdx: number; depth: number; isDummy: boolean }[] = [];
        const walk = (bone: THREE.Bone, parentIdx: number, depth: number) => {
          const myIdx = branch.length;
          branch.push({ bone, parentIdx, depth, isDummy: false });
          const children = bone.children.filter(
            (c): c is THREE.Bone => (c as THREE.Bone).isBone && !excludeSet.has(c.name.toLowerCase())
          );
          for (const ch of children) {
            walk(ch, myIdx, depth + 1);
          }
        };
        walk(rootBone, -1, 0);

        const maxDepth = Math.max(1, ...branch.map((b) => b.depth));
        const localNodesStart = nodes.length;

        for (let i = 0; i < branch.length; i++) {
          const item = branch[i];
          const wPos = item.bone.getWorldPosition(new THREE.Vector3());
          const parentNode = item.parentIdx >= 0 ? nodes[localNodesStart + item.parentIdx] : null;
          const pPos = parentNode ? parentNode.location : wPos;
          const lengthFromParent = parentNode ? Math.max(0.002, wPos.distanceTo(pPos)) : 0;
          const ratio = item.depth / maxDepth;

          const node: SimNode = {
            bone: item.bone,
            parentBone: item.bone.parent,
            parentNode,
            lengthFromParent,
            boneLength: lengthFromParent,
            isDummy: false,
            isRoot: item.parentIdx < 0,
            localRestOffset: item.bone.position.clone(),
            poseLocalQuat: item.bone.quaternion.clone(),
            location: wPos.clone(),
            prevLocation: wPos.clone(),
            poseLocation: wPos.clone(),
            radius: Math.max(0.005, evalCurve(gCfg.radiusCurve, ratio, gCfg.settings.radius || 0.025)),
            damping: THREE.MathUtils.clamp(evalCurve(gCfg.dampingCurve, ratio, gCfg.settings.damping || 0.12), 0.01, 0.95),
            stiffness: THREE.MathUtils.clamp(evalCurve(gCfg.stiffnessCurve, ratio, gCfg.settings.stiffness || 0.08), 0.001, 0.98),
            worldDampingLocation: THREE.MathUtils.clamp(gCfg.settings.worldDampingLocation ?? 0.8, 0, 1),
            limitAngleRad: THREE.MathUtils.degToRad(evalCurve(gCfg.limitAngleCurve, ratio, gCfg.settings.limitAngle || 0)),
            depthRatio: ratio,
            animatedLocalDir: new THREE.Vector3(0, -1, 0)
          };
          nodes.push(node);
        }
      }

      if (nodes.length < 2) continue;

      const capsuleColliders = gCfg.capsuleLimits.map((c) => ({
        bone: this.findBone(c.drivingBone),
        localPos: new THREE.Vector3(c.offsetLocation[0], c.offsetLocation[1], c.offsetLocation[2]),
        localQuat: new THREE.Quaternion(c.offsetQuaternion[0], c.offsetQuaternion[1], c.offsetQuaternion[2], c.offsetQuaternion[3]).normalize(),
        radius: Math.max(0.005, c.radius),
        halfLen: Math.max(0.005, c.length * 0.5)
      }));

      const sphereColliders = gCfg.sphericalLimits.map((s) => ({
        bone: this.findBone(s.drivingBone),
        localPos: new THREE.Vector3(s.offsetLocation[0], s.offsetLocation[1], s.offsetLocation[2]),
        radius: Math.max(0.005, s.radius),
        limitType: s.limitType
      }));

      const planarColliders = gCfg.planarLimits.map((p) => ({
        bone: this.findBone(p.drivingBone),
        localPos: new THREE.Vector3(p.offsetLocation[0], p.offsetLocation[1], p.offsetLocation[2]),
        localNormal: new THREE.Vector3(p.planeNormal[0], p.planeNormal[1], p.planeNormal[2]).normalize()
      }));

      this.groups.push({ config: gCfg, nodes, capsuleColliders, sphereColliders, planarColliders });
    }

    this.buildDebugMeshes();
  }

  public get groupCount(): number {
    return this.groups.length;
  }

  public get boneNodeCount(): number {
    return this.groups.reduce((s, g) => s + g.nodes.length, 0);
  }

  private findBone(name: string): THREE.Bone | null {
    if (!name) return null;
    return this.boneMap.get(name.toLowerCase())?.[0] ?? null;
  }

  public reset(rootObject: THREE.Object3D): void {
    rootObject.updateMatrixWorld(true);
    for (const g of this.groups) {
      for (const n of g.nodes) {
        n.bone.getWorldPosition(n.location);
        n.prevLocation.copy(n.location);
        n.poseLocation.copy(n.location);
      }
    }
    this.hasLastRootPos = false;
  }

  public step(
    dtRaw: number,
    rootObject: THREE.Object3D,
    runtime: PhysicsRuntimeOptions,
    spheres: InteractiveSphereDto[]
  ): void {
    this.debugGroup.visible = runtime.showColliders || runtime.showChains;
    if (!runtime.enabled || this.groups.length === 0) {
      this.updateDebug(false, false);
      return;
    }

    const dt = Math.min(Math.max(dtRaw, 0.001), 1 / 30);
    this.elapsed += dt;

    rootObject.updateMatrixWorld(true);
    const curRootPos = rootObject.getWorldPosition(this._v1);
    if (this.hasLastRootPos) {
      this._vRootDelta.subVectors(curRootPos, this.lastRootPos);
    } else {
      this._vRootDelta.set(0, 0, 0);
    }
    const rootTeleported = this._vRootDelta.lengthSq() > 0.36;
    this.lastRootPos.copy(curRootPos);
    this.hasLastRootPos = true;

    const enabledSpheres = spheres.filter((s) => s.enabled);

    for (const g of this.groups) {
      let groupTeleported = rootTeleported;

      // 1. Update animated pose locations & local quaternions from current skeletal animation
      for (const n of g.nodes) {
        n.bone.getWorldPosition(n.poseLocation);
        n.poseLocalQuat.copy(n.bone.quaternion);
        if (n.isRoot && !groupTeleported && n.poseLocation.distanceToSquared(n.location) > 0.36) {
          groupTeleported = true;
        }
      }

      if (groupTeleported) {
        for (const n of g.nodes) {
          n.location.copy(n.poseLocation);
          n.prevLocation.copy(n.poseLocation);
          if (n.parentNode) {
            const d = n.poseLocation.distanceTo(n.parentNode.poseLocation);
            n.boneLength = d > 0.002 ? d : n.lengthFromParent;
          }
        }
      } else {
        for (const n of g.nodes) {
          if (n.parentNode) {
            const d = n.poseLocation.distanceTo(n.parentNode.poseLocation);
            n.boneLength = d > 0.002 ? d : n.lengthFromParent;
          }
        }
      }

      // Compute current world wind
      const windPhase = this.elapsed * (runtime.windFrequency || 2.5);
      const windForceX = Math.sin(windPhase) * runtime.windStrength * (g.config.windScale || 1) * 0.65;
      const windForceZ = Math.cos(windPhase * 0.77) * runtime.windStrength * (g.config.windScale || 1) * 0.35;

      // 2. Verlet solve from root to tips
      for (const n of g.nodes) {
        if (n.isRoot || !n.parentNode) {
          n.prevLocation.copy(n.poseLocation);
          n.location.copy(n.poseLocation);
          continue;
        }

        const prevSaved = this._vPrev.copy(n.location);
        const effDamp = THREE.MathUtils.clamp(n.damping * runtime.dampingScale, 0.02, 0.95);
        const effStiff = THREE.MathUtils.clamp(n.stiffness * runtime.stiffnessScale, 0.005, 0.98);

        // Velocity with damping
        const vel = this._vVel.subVectors(n.location, n.prevLocation).multiplyScalar(1.0 - effDamp);

        // World damping comp when character translates (uses isolated _vRootDelta)
        if (!groupTeleported) {
          n.location.addScaledVector(this._vRootDelta, 1.0 - n.worldDampingLocation);
        }
        const nextPos = n.location.add(vel);

        // Gentle downward drape + UE group gravity
        const gravY = (-3.2 + g.config.gravity[1] * 0.45) * runtime.gravityScale * (g.config.gravityScale || 1);
        nextPos.x += (g.config.gravity[0] * 0.45 * runtime.gravityScale + windForceX * (0.4 + 0.6 * n.depthRatio)) * dt * dt * 8.0;
        nextPos.y += gravY * dt * dt * 1.4;
        nextPos.z += (g.config.gravity[2] * 0.45 * runtime.gravityScale + windForceZ * (0.4 + 0.6 * n.depthRatio)) * dt * dt * 8.0;

        // Pull toward animated pose via Stiffness
        nextPos.lerp(n.poseLocation, effStiff);

        // 3. LimitAngle cone constraint relative to animated parent-to-child vector
        // (Applied before colliders so body & interactive spheres can still deflect cloth without penetration)
        if (n.limitAngleRad > 1e-4) {
          const animDir = this._v1.subVectors(n.poseLocation, n.parentNode.poseLocation);
          const curDir = this._v2.subVectors(nextPos, n.parentNode.location);
          const aLen = animDir.length();
          const cLen = curDir.length();
          if (aLen > 1e-5 && cLen > 1e-5) {
            animDir.divideScalar(aLen);
            curDir.divideScalar(cLen);
            const dot = THREE.MathUtils.clamp(animDir.dot(curDir), -1, 1);
            const angle = Math.acos(dot);
            if (angle > n.limitAngleRad) {
              const axis = this._capA.crossVectors(animDir, curDir);
              if (axis.lengthSq() > 1e-8) {
                axis.normalize();
                this._q1.setFromAxisAngle(axis, n.limitAngleRad);
                curDir.copy(animDir).applyQuaternion(this._q1);
                nextPos.copy(n.parentNode.location).addScaledVector(curDir, cLen);
              }
            }
          }
        }

        // 4a. Built-in Body Capsule Limits
        for (const cap of g.capsuleColliders) {
          if (!cap.bone) continue;
          cap.bone.updateMatrixWorld(false);
          const center = this._v1.copy(cap.localPos).applyMatrix4(cap.bone.matrixWorld);
          cap.bone.getWorldQuaternion(this._q1).multiply(cap.localQuat);
          // Capsule axis in UE/glTF swapped frame (Y up along length)
          const axis = this._v2.set(0, 1, 0).applyQuaternion(this._q1).multiplyScalar(cap.halfLen);
          this._capA.copy(center).sub(axis);
          this._capB.copy(center).add(axis);
          this.pushOutsideSegment(nextPos, this._capA, this._capB, cap.radius + n.radius);
        }

        // 4b. Built-in Spherical Limits
        for (const sp of g.sphereColliders) {
          if (!sp.bone) continue;
          sp.bone.updateMatrixWorld(false);
          const center = this._v1.copy(sp.localPos).applyMatrix4(sp.bone.matrixWorld);
          this.pushOutsideSphere(nextPos, center, sp.radius + n.radius);
        }

        // 4c. Built-in Planar Limits
        for (const pl of g.planarColliders) {
          if (!pl.bone) continue;
          pl.bone.updateMatrixWorld(false);
          const pt = this._v1.copy(pl.localPos).applyMatrix4(pl.bone.matrixWorld);
          pl.bone.getWorldQuaternion(this._q1);
          const normal = this._v2.copy(pl.localNormal).applyQuaternion(this._q1).normalize();
          const dist = this._capA.subVectors(nextPos, pt).dot(normal);
          if (dist < n.radius) {
            nextPos.addScaledVector(normal, n.radius - dist);
          }
        }

        // 5a. Enforce bone chain segment length (distance constraint)
        const segDir1 = this._v1.subVectors(nextPos, n.parentNode.location);
        const sLen1 = segDir1.length();
        if (sLen1 > 1e-6) {
          segDir1.divideScalar(sLen1);
          nextPos.copy(n.parentNode.location).addScaledVector(segDir1, n.boneLength);
        }

        // 5b. USER INTERACTIVE SPHERE COLLIDERS!
        let hitInteractive = false;
        for (const us of enabledSpheres) {
          const center = this._v1.set(us.position[0], us.position[1], us.position[2]);
          const minDist = us.radius + n.radius;
          const diff = this._v2.subVectors(nextPos, center);
          const distSq = diff.lengthSq();
          if (distSq < minDist * minDist) {
            const dist = Math.sqrt(distSq);
            const pushNormal = dist > 1e-5 ? diff.divideScalar(dist) : this._v2.set(0, 1, 0);
            nextPos.copy(center).addScaledVector(pushNormal, minDist);
            prevSaved.addScaledVector(pushNormal, -(minDist - dist) * runtime.sphereBounciness * 0.25);
            hitInteractive = true;
          }
        }

        if (hitInteractive) {
          const segDir2 = this._v1.subVectors(nextPos, n.parentNode.location);
          const sLen2 = segDir2.length();
          if (sLen2 > 1e-6) {
            segDir2.divideScalar(sLen2);
            nextPos.copy(n.parentNode.location).addScaledVector(segDir2, n.boneLength);
          }
          for (const us of enabledSpheres) {
            const center = this._v1.set(us.position[0], us.position[1], us.position[2]);
            const minDist = us.radius + n.radius;
            const diff = this._v2.subVectors(nextPos, center);
            const distSq = diff.lengthSq();
            if (distSq < minDist * minDist) {
              const dist = Math.sqrt(distSq);
              const pushNormal = dist > 1e-5 ? diff.divideScalar(dist) : this._v2.set(0, 1, 0);
              nextPos.copy(center).addScaledVector(pushNormal, minDist);
            }
          }
        }

        n.prevLocation.copy(prevSaved);
        n.location.copy(nextPos);
      }

      // 6. Aim parent bones along solved segments using LIVE child-minus-parent vectors
      // (Avoids compounding ancestor delta rotations down deep chains!)
      const alpha = THREE.MathUtils.clamp(g.config.alpha ?? 1.0, 0.0, 1.0);
      if (alpha <= 1e-4) continue;
      const aimedParents = new Set<SimNode>();

      for (const n of g.nodes) {
        if (n.isRoot || !n.parentNode) continue;
        const pNode = n.parentNode;
        if (aimedParents.has(pNode)) continue;
        aimedParents.add(pNode);

        pNode.bone.getWorldPosition(this._vCurParent);
        n.bone.getWorldPosition(this._vCurChild);

        const curDir = this._vAimCur.subVectors(this._vCurChild, this._vCurParent);
        const solvedDir = this._vAimSolved.subVectors(n.location, this._vCurParent);
        if (curDir.lengthSq() < 1e-8 || solvedDir.lengthSq() < 1e-8) continue;

        curDir.normalize();
        solvedDir.normalize();

        this._q1.setFromUnitVectors(curDir, solvedDir);

        pNode.bone.getWorldQuaternion(this._qWorld);
        this._q2.copy(this._q1).multiply(this._qWorld).normalize();

        if (pNode.bone.parent) {
          pNode.bone.parent.getWorldQuaternion(this._qParentWorldInv).invert();
          this._qLocalTarget.copy(this._qParentWorldInv).multiply(this._q2).normalize();
        } else {
          this._qLocalTarget.copy(this._q2);
        }

        if (alpha < 0.999) {
          if (pNode.poseLocalQuat.dot(this._qLocalTarget) < 0) {
            this._qLocalTarget.set(-this._qLocalTarget.x, -this._qLocalTarget.y, -this._qLocalTarget.z, -this._qLocalTarget.w);
          }
          pNode.bone.quaternion.slerpQuaternions(pNode.poseLocalQuat, this._qLocalTarget, alpha).normalize();
        } else {
          pNode.bone.quaternion.copy(this._qLocalTarget);
        }
        pNode.bone.updateMatrixWorld(true);
        const dupList = this.boneMap.get(pNode.bone.name.toLowerCase());
        if (dupList && dupList.length > 1) {
          for (const dup of dupList) {
            if (dup !== pNode.bone) {
              dup.quaternion.copy(pNode.bone.quaternion);
              dup.updateMatrixWorld(true);
            }
          }
        }
      }
    }

    this.updateDebug(runtime.showChains, runtime.showColliders);
  }

  private pushOutsideSphere(pos: THREE.Vector3, center: THREE.Vector3, minDist: number): void {
    const diff = this._vSphDiff.subVectors(pos, center);
    const dSq = diff.lengthSq();
    if (dSq < minDist * minDist) {
      const d = Math.sqrt(dSq);
      const dir = d > 1e-5 ? diff.divideScalar(d) : this._vSphDiff.set(0, 1, 0);
      pos.copy(center).addScaledVector(dir, minDist);
    }
  }

  private pushOutsideSegment(pos: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, minDist: number): void {
    const abX = b.x - a.x, abY = b.y - a.y, abZ = b.z - a.z;
    const apX = pos.x - a.x, apY = pos.y - a.y, apZ = pos.z - a.z;
    const lenSq = abX * abX + abY * abY + abZ * abZ;
    let t = lenSq > 1e-7 ? (apX * abX + apY * abY + apZ * abZ) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abX * t;
    const cy = a.y + abY * t;
    const cz = a.z + abZ * t;
    const dx = pos.x - cx, dy = pos.y - cy, dz = pos.z - cz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < minDist * minDist) {
      const dist = Math.sqrt(distSq);
      if (dist > 1e-5) {
        const s = minDist / dist;
        pos.set(cx + dx * s, cy + dy * s, cz + dz * s);
      } else {
        pos.set(cx, cy + minDist, cz);
      }
    }
  }

  private clearDebug(): void {
    while (this.debugGroup.children.length > 0) {
      const c = this.debugGroup.children[0];
      this.debugGroup.remove(c);
      if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
    }
    this.chainLines = null;
    this.colliderDebugMeshes = [];
  }

  private buildDebugMeshes(): void {
    let segCount = 0;
    for (const g of this.groups) {
      for (const n of g.nodes) if (n.parentNode) segCount++;
      for (const cap of g.capsuleColliders) {
        const geo = new THREE.CapsuleGeometry(cap.radius, cap.halfLen * 2, 4, 10);
        const mat = new THREE.MeshBasicMaterial({ color: '#f59e0b', wireframe: true, transparent: true, opacity: 0.45 });
        const m = new THREE.Mesh(geo, mat);
        m.userData = { type: 'capsule', cap };
        this.debugGroup.add(m);
        this.colliderDebugMeshes.push(m);
      }
      for (const sp of g.sphereColliders) {
        const geo = new THREE.SphereGeometry(sp.radius, 10, 8);
        const mat = new THREE.MeshBasicMaterial({ color: '#ec4899', wireframe: true, transparent: true, opacity: 0.45 });
        const m = new THREE.Mesh(geo, mat);
        m.userData = { type: 'sphere', sp };
        this.debugGroup.add(m);
        this.colliderDebugMeshes.push(m);
      }
    }

    if (segCount > 0) {
      const positions = new Float32Array(segCount * 6);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({ color: '#22d3ee', depthTest: false, transparent: true, opacity: 0.9 });
      this.chainLines = new THREE.LineSegments(geo, mat);
      this.chainLines.renderOrder = 999;
      this.chainLines.frustumCulled = false;
      this.debugGroup.add(this.chainLines);
    }
  }

  private updateDebug(showChains: boolean, showColliders: boolean): void {
    if (this.chainLines) {
      this.chainLines.visible = showChains;
      if (showChains) {
        const attr = this.chainLines.geometry.getAttribute('position') as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        let ptr = 0;
        for (const g of this.groups) {
          for (const n of g.nodes) {
            if (!n.parentNode) continue;
            arr[ptr++] = n.parentNode.location.x;
            arr[ptr++] = n.parentNode.location.y;
            arr[ptr++] = n.parentNode.location.z;
            arr[ptr++] = n.location.x;
            arr[ptr++] = n.location.y;
            arr[ptr++] = n.location.z;
          }
        }
        attr.needsUpdate = true;
      }
    }

    for (const m of this.colliderDebugMeshes) {
      m.visible = showColliders;
      if (!showColliders) continue;
      if (m.userData.type === 'capsule') {
        const cap = m.userData.cap as SimGroup['capsuleColliders'][0];
        if (cap.bone) {
          cap.bone.updateMatrixWorld(false);
          m.position.copy(cap.localPos).applyMatrix4(cap.bone.matrixWorld);
          cap.bone.getWorldQuaternion(m.quaternion).multiply(cap.localQuat);
        }
      } else if (m.userData.type === 'sphere') {
        const sp = m.userData.sp as SimGroup['sphereColliders'][0];
        if (sp.bone) {
          sp.bone.updateMatrixWorld(false);
          m.position.copy(sp.localPos).applyMatrix4(sp.bone.matrixWorld);
        }
      }
    }
  }
}

