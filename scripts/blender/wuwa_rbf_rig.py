# SPDX-License-Identifier: MIT
# WuWaViewer Blender RBF & PoseDriver Rig Integration
# Compatible with Blender 4.2+ and 5.2 LTS (single-file addon or CLI script).

bl_info = {
    "name": "WuWaViewer RBF & PoseDriver Rig",
    "author": "WuWaViewer Contributors",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar (N) > WuWa Rig",
    "description": "Applies Wuthering Waves USkeleton RBFDrivers (corrective shape keys) and AnimBlueprint PoseDrivers onto imported glTF character rigs.",
    "category": "Rigging",
}

import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import bpy
from bpy.app.handlers import persistent
from mathutils import Matrix, Quaternion, Vector

CONFIG_PROP = "wuwa_rbf_config_json"
SOLVER_PROP = "wuwa_rbf_solver_mode"
RUNTIME_TEXT_NAME = "wuwa_rbf_driver_runtime.py"
MCH_PREFIX = "MCH_PD_"
MCH_COLLECTION = "WuWa_PoseDriver_MCH"
CONSTRAINT_LOC_NAME = "WUWA_PD_LOC"
CONSTRAINT_ROT_NAME = "WUWA_PD_ROT"
DRIVER_TAG = "WUWA_RBF"

_S_UE_TO_BL = Matrix(((1.0, 0.0, 0.0), (0.0, -1.0, 0.0), (0.0, 0.0, 1.0)))

# Per-armature parsed cache + pose-signature memoization so moving ANY bone in
# interactive Pose Mode or Timeline invalidates immediately without stale reads.
_PARSED_CFG_CACHE: dict[str, dict[str, Any]] = {}
_RBF_POSE_CACHE: dict[str, tuple[tuple[float, ...], dict[str, float]]] = {}
_PD_POSE_CACHE: dict[str, tuple[tuple[float, ...], dict[str, tuple[Vector, Quaternion]]]] = {}
_ANALYTIC_SOLVE_CACHE: dict[tuple[str, int], dict[str, Any]] = {}


def _clamp(val: float, lo: float, hi: float) -> float:
    return lo if val < lo else (hi if val > hi else val)


def _ue_quat_to_mat3_ue(q_xyzw: list[float]) -> Matrix:
    q = Quaternion((q_xyzw[3], q_xyzw[0], q_xyzw[1], q_xyzw[2]))
    if q.magnitude > 1e-6:
        q.normalize()
    return q.to_matrix()


def _eval_curve(keys: list[dict[str, Any]], t: float) -> float:
    if not keys:
        return 1.0
    if t <= keys[0]["time"]:
        return float(keys[0]["value"])
    for i in range(len(keys) - 1):
        k0, k1 = keys[i], keys[i + 1]
        t0, t1 = float(k0["time"]), float(k1["time"])
        if t <= t1:
            dt = t1 - t0
            if dt <= 1e-8:
                return float(k1["value"])
            a = (t - t0) / dt
            return float(k0["value"]) * (1.0 - a) + float(k1["value"]) * a
    return float(keys[-1]["value"])


def _eval_precomp_table(table: dict[str, Any], deg_y: float, deg_z: float) -> list[float]:
    ly = float(table["rotationLimitY"])
    lz = float(table["rotationLimitZ"])
    iv = max(1e-4, float(table["interval"]))
    ny = max(1, int(table["countY"]))
    nz = max(1, int(table["countZ"]))
    rows = table["weights"]
    if not rows:
        return []

    fy = _clamp((deg_y + ly) / iv, 0.0, float(ny - 1))
    fz = _clamp((deg_z + lz) / iv, 0.0, float(nz - 1))
    y0 = min(int(math.floor(fy)), max(0, ny - 2))
    y1 = min(y0 + 1, ny - 1)
    z0 = min(int(math.floor(fz)), max(0, nz - 2))
    z1 = min(z0 + 1, nz - 1)
    ty = fy - float(y0)
    tz = fz - float(z0)

    r00 = rows[y0 * nz + z0]
    r01 = rows[y0 * nz + z1]
    r10 = rows[y1 * nz + z0]
    r11 = rows[y1 * nz + z1]
    n_ch = len(r00)
    out = [0.0] * n_ch
    w00 = (1.0 - ty) * (1.0 - tz)
    w01 = (1.0 - ty) * tz
    w10 = ty * (1.0 - tz)
    w11 = ty * tz
    for i in range(n_ch):
        out[i] = w00 * r00[i] + w01 * r01[i] + w10 * r10[i] + w11 * r11[i]
    return out


def _solve_linear_system(a_in: list[list[float]], b_in: list[list[float]]) -> list[list[float]]:
    """Small pure-Python Gauss-Jordan solver (keeps addon dependency-free)."""
    n = len(a_in)
    m = len(b_in[0]) if n > 0 else 0
    aug = [row[:] + b_in[i][:] for i, row in enumerate(a_in)]

    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(aug[r][col]))
        if piv != col:
            aug[col], aug[piv] = aug[piv], aug[col]
        diag = aug[col][col]
        if abs(diag) < 1e-10:
            continue
        inv = 1.0 / diag
        for j in range(col, n + m):
            aug[col][j] *= inv
        for r in range(n):
            if r == col:
                continue
            fac = aug[r][col]
            if abs(fac) < 1e-12:
                continue
            for j in range(col, n + m):
                aug[r][j] -= fac * aug[col][j]

    return [row[n:] for row in aug]


def _get_analytic_model(cache_key: tuple[str, int], drv: dict[str, Any]) -> dict[str, Any]:
    cached = _ANALYTIC_SOLVE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    targets = drv.get("driveSettings", [])
    morphs = drv.get("drivenMorphTargets", [])
    dirs: list[Vector] = []
    weights_mat: list[list[float]] = []

    for pt in targets:
        vals = pt.get("driverValues", [])
        if len(vals) < 3:
            continue
        v = Vector((float(vals[0]), float(vals[1]), float(vals[2])))
        if v.length < 1e-6:
            v = Vector((1.0, 0.0, 0.0))
        else:
            v.normalize()
        dirs.append(v)
        dw = pt.get("drivenWeights", {})
        weights_mat.append([float(dw.get(mn, 0.0)) for mn in morphs])

    n = len(dirs)
    if n == 0 or not morphs:
        model = {"dirs": [], "sigma": 0.5, "alpha": [], "morphs": morphs}
        _ANALYTIC_SOLVE_CACHE[cache_key] = model
        return model

    nn_angles: list[float] = []
    for i in range(n):
        best = math.pi
        for j in range(n):
            if i == j:
                continue
            ang = math.acos(_clamp(dirs[i].dot(dirs[j]), -1.0, 1.0))
            if ang > 1e-3 and ang < best:
                best = ang
        if best < math.pi:
            nn_angles.append(best)

    nn_angles.sort()
    sigma = nn_angles[len(nn_angles) // 2] if nn_angles else 0.55
    sigma = _clamp(sigma * 0.9, 0.30, 1.15)
    inv_sig2 = 1.0 / (sigma * sigma)

    phi = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            ang = math.acos(_clamp(dirs[i].dot(dirs[j]), -1.0, 1.0))
            phi[i][j] = math.exp(-(ang * ang) * inv_sig2)
        phi[i][i] += 1e-3

    alpha = _solve_linear_system(phi, weights_mat)
    model = {"dirs": dirs, "inv_sig2": inv_sig2, "alpha": alpha, "morphs": morphs}
    _ANALYTIC_SOLVE_CACHE[cache_key] = model
    return model


def _eval_analytic_driver(cache_key: tuple[str, int], drv: dict[str, Any], v_ue: Vector) -> dict[str, float]:
    model = _get_analytic_model(cache_key, drv)
    dirs: list[Vector] = model["dirs"]
    morphs: list[str] = model["morphs"]
    if not dirs or not morphs:
        return {}

    v_dir = v_ue.normalized() if v_ue.length > 1e-6 else Vector((1.0, 0.0, 0.0))
    inv_sig2 = model["inv_sig2"]
    alpha = model["alpha"]
    n_m = len(morphs)
    sums = [0.0] * n_m
    for i, d_i in enumerate(dirs):
        ang = math.acos(_clamp(v_dir.dot(d_i), -1.0, 1.0))
        k = math.exp(-(ang * ang) * inv_sig2)
        row = alpha[i]
        for m in range(n_m):
            sums[m] += k * row[m]

    return {morphs[m]: _clamp(sums[m], 0.0, 1.0) for m in range(n_m)}


def _get_armature_cfg(arm_obj: bpy.types.Object) -> dict[str, Any] | None:
    raw = arm_obj.get(CONFIG_PROP)
    if not raw or not isinstance(raw, str):
        return None
    cached = _PARSED_CFG_CACHE.get(arm_obj.name)
    if cached is not None and cached.get("_raw_len") == len(raw) and cached.get("_raw_hash") == hash(raw):
        return cached
    cfg = json.loads(raw)
    cfg["_raw_len"] = len(raw)
    cfg["_raw_hash"] = hash(raw)
    for drv in cfg.get("rbfDrivers", []):
        drv["_baseCompRotUe"] = _ue_quat_to_mat3_ue(drv["baseCompRestQuat"])
    for pd in cfg.get("poseDrivers", []):
        pd["_srcCompRotUe"] = _ue_quat_to_mat3_ue(pd["sourceCompRestQuat"])
        pd["_parentCompMats"] = {
            bn: _ue_quat_to_mat3_ue(q) for bn, q in pd.get("boneParentCompRestQuats", {}).items()
        }
        for p in pd.get("poses", []):
            tq = p["targetRotationQuat"]
            p["_targetQuat"] = Quaternion((tq[3], tq[0], tq[1], tq[2])).normalized()
            for db in p.get("drivenBones", []):
                dq = db["deltaRotationQuat"]
                db["_deltaQuat"] = Quaternion((dq[3], dq[0], dq[1], dq[2])).normalized()
                db["_deltaTrans"] = Vector(db["deltaTranslationCm"])
    _PARSED_CFG_CACHE[arm_obj.name] = cfg
    _ANALYTIC_SOLVE_CACHE.clear()
    return cfg


def _mat_sig(pb: bpy.types.PoseBone | None, out: list[float]) -> None:
    if pb is None:
        return
    m = pb.matrix
    out.extend((
        m[0][0], m[0][1], m[0][2], m[0][3],
        m[1][0], m[1][1], m[1][2], m[1][3],
        m[2][0], m[2][1], m[2][2], m[2][3],
    ))


def _eval_driver_vec_ue(arm_obj: bpy.types.Object, drv: dict[str, Any]) -> Vector | None:
    pb_base = arm_obj.pose.bones.get(drv["baseBoneName"])
    pb_drv = arm_obj.pose.bones.get(drv["driverBoneName"])
    if pb_base is None or pb_drv is None:
        return None

    parent_name = drv.get("baseParentBoneName")
    pb_parent = arm_obj.pose.bones.get(parent_name) if parent_name else pb_base.parent
    delta_arm = pb_drv.head - pb_base.head
    if pb_parent is not None:
        r_p_rest = pb_parent.bone.matrix_local.to_3x3().normalized()
        r_p_cur = pb_parent.matrix.to_3x3().normalized()
        delta_rest_arm = r_p_rest @ (r_p_cur.inverted() @ delta_arm)
    else:
        delta_rest_arm = delta_arm

    if delta_rest_arm.length < 1e-8:
        return None

    d_ue_cm = Vector((delta_rest_arm.x, -delta_rest_arm.y, delta_rest_arm.z)).normalized() * float(drv["restRadiusCm"])
    r_base_comp: Matrix = drv["_baseCompRotUe"]
    return r_base_comp.inverted() @ d_ue_cm


def _evaluate_all_rbf_morphs(arm_obj: bpy.types.Object, cfg: dict[str, Any]) -> dict[str, float]:
    rbfs = cfg.get("rbfDrivers", [])
    if not rbfs:
        return {}

    solver_mode = str(arm_obj.get(SOLVER_PROP, "PRECOMPUTE")).upper()
    sig_list: list[float] = [1.0 if solver_mode == "ANALYTIC" else 0.0]
    p_bones = arm_obj.pose.bones
    seen_bones: set[str] = set()
    for drv in rbfs:
        for bn in (drv["baseBoneName"], drv["driverBoneName"], drv.get("baseParentBoneName") or ""):
            if bn and bn not in seen_bones:
                seen_bones.add(bn)
                _mat_sig(p_bones.get(bn), sig_list)
    sig = tuple(sig_list)

    cached = _RBF_POSE_CACHE.get(arm_obj.name)
    if cached is not None and cached[0] == sig:
        return cached[1]

    raw_by_drv: list[dict[str, float]] = []
    for idx, drv in enumerate(rbfs):
        v_ue = _eval_driver_vec_ue(arm_obj, drv)
        if v_ue is None:
            raw_by_drv.append({})
            continue

        pre = drv.get("precomputation")
        if solver_mode != "ANALYTIC" and pre is not None:
            deg_y = math.degrees(math.atan2(v_ue.y, v_ue.x))
            deg_z = math.degrees(math.atan2(v_ue.z, math.hypot(v_ue.x, v_ue.y)))
            vals = _eval_precomp_table(pre, deg_y, deg_z)
            morphs = drv.get("drivenMorphTargets", [])
            w_map = {morphs[i]: _clamp(vals[i], 0.0, 1.0) for i in range(min(len(morphs), len(vals)))}
        else:
            w_map = _eval_analytic_driver((arm_obj.name, idx), drv, v_ue)
        raw_by_drv.append(w_map)

    out_by_drv = [dict(m) for m in raw_by_drv]
    for idx, drv in enumerate(rbfs):
        wm = drv.get("weightModifier")
        if not wm:
            continue
        dst_idx = int(wm["dstDriverIndex"])
        if not (0 <= dst_idx < len(out_by_drv)):
            continue
        src_val = raw_by_drv[idx].get(wm["srcWeight"], 0.0)
        factor = _eval_curve(wm.get("factorCurve", []), src_val)
        dst_key = wm["dstWeight"]
        if dst_key in out_by_drv[dst_idx]:
            out_by_drv[dst_idx][dst_key] = _clamp(out_by_drv[dst_idx][dst_key] * factor, 0.0, 1.0)

    merged: dict[str, float] = {}
    for w_map in out_by_drv:
        for morph, val in w_map.items():
            merged[morph] = _clamp(merged.get(morph, 0.0) + val, 0.0, 1.0)

    _RBF_POSE_CACHE[arm_obj.name] = (sig, merged)
    return merged


def _evaluate_all_pose_drivers(arm_obj: bpy.types.Object, cfg: dict[str, Any]) -> dict[str, tuple[Vector, Quaternion]]:
    pds = cfg.get("poseDrivers", [])
    if not pds:
        return {}

    p_bones = arm_obj.pose.bones
    sig_list: list[float] = []
    seen_bones: set[str] = set()
    for pd in pds:
        sb = pd["sourceBone"]
        if sb not in seen_bones:
            seen_bones.add(sb)
            pb_sb = p_bones.get(sb)
            _mat_sig(pb_sb, sig_list)
            _mat_sig(pb_sb.parent if pb_sb else None, sig_list)
    sig = tuple(sig_list)

    cached = _PD_POSE_CACHE.get(arm_obj.name)
    if cached is not None and cached[0] == sig:
        return cached[1]

    accum_t: dict[str, Vector] = {}
    accum_q_terms: dict[str, list[tuple[float, Quaternion]]] = {}

    for pd in pds:
        pb_src = p_bones.get(pd["sourceBone"])
        if pb_src is None:
            continue
        pb_parent = p_bones.get(pd.get("sourceParentBone") or "") or pb_src.parent

        r_src_delta_arm = pb_src.matrix.to_3x3().normalized() @ pb_src.bone.matrix_local.to_3x3().normalized().inverted()
        if pb_parent is not None:
            r_p_delta_arm = pb_parent.matrix.to_3x3().normalized() @ pb_parent.bone.matrix_local.to_3x3().normalized().inverted()
            r_src_delta_arm = r_p_delta_arm.inverted() @ r_src_delta_arm

        r_delta_ue_comp = _S_UE_TO_BL @ r_src_delta_arm @ _S_UE_TO_BL
        r_src_comp: Matrix = pd["_srcCompRotUe"]
        q_cur_ue = (r_src_comp.inverted() @ r_delta_ue_comp @ r_src_comp).to_quaternion()
        q_cur_ue.normalize()

        poses = pd.get("poses", [])
        radius = max(1e-3, float(pd.get("radius", 22.5)))
        thresh = float(pd.get("weightThreshold", 1e-4))
        norm_method = pd.get("normalizeMethod", "AlwaysNormalize")

        raw_w: list[float] = []
        for pose in poses:
            q_t: Quaternion = pose["_targetQuat"]
            dot = _clamp(abs(q_cur_ue.dot(q_t)), 0.0, 1.0)
            dist_deg = math.degrees(2.0 * math.acos(dot))
            eff_r = max(1e-3, radius * float(pose.get("targetScale", 1.0)))
            w = math.exp(-((dist_deg / eff_r) ** 2))
            if w < thresh:
                w = 0.0
            raw_w.append(w)

        sum_w = sum(raw_w)
        if sum_w > 1e-8 and (norm_method == "AlwaysNormalize" or (norm_method == "OnlyNormalizeAboveOne" and sum_w > 1.0)):
            weights = [w / sum_w for w in raw_w]
        else:
            weights = raw_w

        for pose, w in zip(poses, weights):
            if w <= 1e-6:
                continue
            for db in pose.get("drivenBones", []):
                bn = db["boneName"]
                dt: Vector = db["_deltaTrans"]
                dq: Quaternion = db["_deltaQuat"]
                if bn in accum_t:
                    accum_t[bn] = accum_t[bn] + dt * w
                else:
                    accum_t[bn] = dt * w
                accum_q_terms.setdefault(bn, []).append((w, dq))

    parent_mats_all: dict[str, Matrix] = {}
    for pd in pds:
        parent_mats_all.update(pd.get("_parentCompMats", {}))

    result: dict[str, tuple[Vector, Quaternion]] = {}
    all_driven = set(accum_t.keys()) | set(accum_q_terms.keys())
    for bn in all_driven:
        bone_rest = arm_obj.data.bones.get(bn)
        r_p_comp = parent_mats_all.get(bn)
        if bone_rest is None or r_p_comp is None:
            continue

        t_ue_cm = accum_t.get(bn, Vector((0.0, 0.0, 0.0)))
        q_terms = accum_q_terms.get(bn, [])
        w_active = sum(w for w, _ in q_terms)
        id_w = max(0.0, 1.0 - w_active)
        qw, qx, qy, qz = id_w, 0.0, 0.0, 0.0
        for w, dq in q_terms:
            # Keep shortest arc relative to identity quaternion (1, 0, 0, 0)
            s = w if dq.w >= 0.0 else -w
            qw += s * dq.w
            qx += s * dq.x
            qy += s * dq.y
            qz += s * dq.z
        q_add_ue = Quaternion((qw, qx, qy, qz))
        if q_add_ue.magnitude > 1e-6:
            q_add_ue.normalize()
        else:
            q_add_ue = Quaternion((1.0, 0.0, 0.0, 0.0))

        r_b_rest_bl = bone_rest.matrix_local.to_3x3().normalized()
        r_arm_delta = _S_UE_TO_BL @ (r_p_comp @ q_add_ue.to_matrix() @ r_p_comp.inverted()) @ _S_UE_TO_BL
        q_pb = (r_b_rest_bl.inverted() @ r_arm_delta @ r_b_rest_bl).to_quaternion()
        q_pb.normalize()
        t_pb = r_b_rest_bl.inverted() @ (_S_UE_TO_BL @ (r_p_comp @ (t_ue_cm * 0.01)))
        result[bn] = (t_pb, q_pb)

    _PD_POSE_CACHE[arm_obj.name] = (sig, result)
    return result


def wuwa_rbf_eval(arm_name: str, morph_name: str) -> float:
    arm_obj = bpy.data.objects.get(arm_name)
    if arm_obj is None or arm_obj.type != "ARMATURE":
        return 0.0
    cfg = _get_armature_cfg(arm_obj)
    if cfg is None:
        return 0.0
    return _evaluate_all_rbf_morphs(arm_obj, cfg).get(morph_name, 0.0)


def wuwa_pd_eval(arm_name: str, bone_name: str, channel: str, idx: int) -> float:
    arm_obj = bpy.data.objects.get(arm_name)
    if arm_obj is None or arm_obj.type != "ARMATURE":
        return 1.0 if (channel == "quat" and idx == 0) else 0.0
    cfg = _get_armature_cfg(arm_obj)
    if cfg is None:
        return 1.0 if (channel == "quat" and idx == 0) else 0.0
    res = _evaluate_all_pose_drivers(arm_obj, cfg).get(bone_name)
    if res is None:
        return 1.0 if (channel == "quat" and idx == 0) else 0.0
    t_pb, q_pb = res
    return float(t_pb[idx] if channel == "loc" else q_pb[idx])


def register_driver_namespace() -> None:
    bpy.app.driver_namespace["wuwa_rbf_eval"] = wuwa_rbf_eval
    bpy.app.driver_namespace["wuwa_pd_eval"] = wuwa_pd_eval


def _ensure_embedded_runtime_text() -> None:
    """Embed a tiny shim Text datablock so saved .blend files work standalone if opened without addon."""
    shim = (
        "# Auto-generated by WuWaViewer RBF Rig\n"
        "import bpy\n"
        "try:\n"
        "    import wuwa_rbf_rig\n"
        "    wuwa_rbf_rig.register_driver_namespace()\n"
        "except ImportError:\n"
        "    pass\n"
    )
    txt = bpy.data.texts.get(RUNTIME_TEXT_NAME) or bpy.data.texts.new(RUNTIME_TEXT_NAME)
    if txt.as_string() != shim:
        txt.from_string(shim)


def find_target_armature(preferred_name: str | None = None) -> bpy.types.Object | None:
    if preferred_name:
        obj = bpy.data.objects.get(preferred_name)
        if obj and obj.type == "ARMATURE":
            return obj
    act = getattr(bpy.context, "active_object", None)
    if act:
        if act.type == "ARMATURE":
            return act
        if act.type == "MESH":
            arm = act.find_armature()
            if arm:
                return arm
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE":
            return obj
    return None


def find_bound_meshes(arm_obj: bpy.types.Object) -> list[bpy.types.Object]:
    meshes: list[bpy.types.Object] = []
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.data.shape_keys is None:
            continue
        if obj.parent == arm_obj or any(m.type == "ARMATURE" and m.object == arm_obj for m in obj.modifiers):
            meshes.append(obj)
    return meshes


def _add_bone_rot_dep_vars(driver: bpy.types.Driver, arm_obj: bpy.types.Object, bone_names: list[str]) -> None:
    for bi, bn in enumerate(bone_names):
        if not bn or arm_obj.data.bones.get(bn) is None:
            continue
        var = driver.variables.new()
        var.name = f"b{bi}"
        var.type = "TRANSFORMS"
        tgt = var.targets[0]
        tgt.id = arm_obj
        tgt.bone_target = bn
        tgt.transform_type = "ROT_X"
        tgt.transform_space = "LOCAL_SPACE"


def _clear_rbf_drivers_on_meshes(meshes: list[bpy.types.Object]) -> int:
    removed = 0
    for mesh_obj in meshes:
        sk = mesh_obj.data.shape_keys
        if not sk or not sk.animation_data:
            continue
        to_remove = [
            fc for fc in sk.animation_data.drivers
            if fc.driver and "wuwa_rbf_eval(" in fc.driver.expression
        ]
        for fc in to_remove:
            dp = fc.data_path
            sk.driver_remove(dp)
            if dp.startswith('key_blocks["') and dp.endswith('"].value'):
                kname = dp[len('key_blocks["'):-len('"].value')]
                kb = sk.key_blocks.get(kname)
                if kb is not None:
                    kb.value = 0.0
            removed += 1
    return removed


def _clear_pose_drivers_on_armature(arm_obj: bpy.types.Object) -> int:
    removed = 0
    # Remove constraints on target bones
    for pb in arm_obj.pose.bones:
        for cname in (CONSTRAINT_LOC_NAME, CONSTRAINT_ROT_NAME):
            con = pb.constraints.get(cname)
            if con is not None:
                pb.constraints.remove(con)
                removed += 1

    # Remove drivers referencing MCH_PD_ bones
    if arm_obj.animation_data:
        for fc in list(arm_obj.animation_data.drivers):
            if f'pose.bones["{MCH_PREFIX}' in fc.data_path:
                arm_obj.driver_remove(fc.data_path, fc.array_index)

    # Remove MCH_PD_ edit bones cleanly
    if any(b.name.startswith(MCH_PREFIX) for b in arm_obj.data.bones):
        prev_active = bpy.context.view_layer.objects.active
        prev_mode = prev_active.mode if prev_active else "OBJECT"
        if prev_active and prev_mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        bpy.context.view_layer.objects.active = arm_obj
        bpy.ops.object.mode_set(mode="EDIT")
        ebones = arm_obj.data.edit_bones
        for eb in [b for b in ebones if b.name.startswith(MCH_PREFIX)]:
            ebones.remove(eb)
            removed += 1
        bpy.ops.object.mode_set(mode="OBJECT")
        if prev_active:
            bpy.context.view_layer.objects.active = prev_active
            if prev_mode != "OBJECT":
                bpy.ops.object.mode_set(mode=prev_mode)

    coll = arm_obj.data.collections.get(MCH_COLLECTION) if hasattr(arm_obj.data, "collections") else None
    if coll is not None:
        arm_obj.data.collections.remove(coll)

    return removed


def remove_rbf_rig(arm_obj: bpy.types.Object) -> dict[str, int]:
    meshes = find_bound_meshes(arm_obj)
    n_sk = _clear_rbf_drivers_on_meshes(meshes)
    n_pd = _clear_pose_drivers_on_armature(arm_obj)
    if CONFIG_PROP in arm_obj:
        del arm_obj[CONFIG_PROP]
    if SOLVER_PROP in arm_obj:
        del arm_obj[SOLVER_PROP]
    _PARSED_CFG_CACHE.pop(arm_obj.name, None)
    _RBF_POSE_CACHE.pop(arm_obj.name, None)
    _PD_POSE_CACHE.pop(arm_obj.name, None)
    return {"morph_drivers_removed": n_sk, "pose_driver_items_removed": n_pd}


def _setup_rbf_shape_key_drivers(arm_obj: bpy.types.Object, meshes: list[bpy.types.Object], cfg: dict[str, Any]) -> int:
    _clear_rbf_drivers_on_meshes(meshes)
    rbfs = cfg.get("rbfDrivers", [])
    if not rbfs:
        return 0

    morph_deps: dict[str, list[str]] = {}
    for drv in rbfs:
        deps = [drv["baseBoneName"], drv["driverBoneName"]]
        if drv.get("baseParentBoneName"):
            deps.append(drv["baseParentBoneName"])
        for morph in drv.get("drivenMorphTargets", []):
            lst = morph_deps.setdefault(morph, [])
            for d in deps:
                if d not in lst:
                    lst.append(d)

    created = 0
    for mesh_obj in meshes:
        sk = mesh_obj.data.shape_keys
        if sk is None:
            continue
        for morph, dep_bones in morph_deps.items():
            kb = sk.key_blocks.get(morph)
            if kb is None:
                continue
            fc = kb.driver_add("value")
            drv = fc.driver
            drv.type = "SCRIPTED"
            _add_bone_rot_dep_vars(drv, arm_obj, dep_bones)
            drv.expression = f'wuwa_rbf_eval("{arm_obj.name}", "{morph}")'
            created += 1

    return created


def _setup_pose_driver_bones(arm_obj: bpy.types.Object, cfg: dict[str, Any]) -> int:
    _clear_pose_drivers_on_armature(arm_obj)
    pds = cfg.get("poseDrivers", [])
    if not pds:
        return 0

    driven_to_sources: dict[str, list[str]] = {}
    for pd in pds:
        sb = pd["sourceBone"]
        sp = pd.get("sourceParentBone")
        for pose in pd.get("poses", []):
            for db in pose.get("drivenBones", []):
                bn = db["boneName"]
                if arm_obj.data.bones.get(bn) is None:
                    continue
                lst = driven_to_sources.setdefault(bn, [])
                for s in (sb, sp):
                    if s and s not in lst:
                        lst.append(s)

    if not driven_to_sources:
        return 0

    prev_active = bpy.context.view_layer.objects.active
    prev_mode = prev_active.mode if prev_active else "OBJECT"
    if prev_active and prev_mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")

    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    ebones = arm_obj.data.edit_bones
    for bn in driven_to_sources:
        src_eb = ebones.get(bn)
        if src_eb is None:
            continue
        mch_name = MCH_PREFIX + bn
        mch_eb = ebones.get(mch_name) or ebones.new(mch_name)
        mch_eb.head = src_eb.head.copy()
        mch_eb.tail = src_eb.tail.copy()
        mch_eb.roll = src_eb.roll
        mch_eb.parent = src_eb.parent
        mch_eb.use_connect = False
        mch_eb.use_deform = False

    bpy.ops.object.mode_set(mode="OBJECT")

    if hasattr(arm_obj.data, "collections"):
        coll = arm_obj.data.collections.get(MCH_COLLECTION) or arm_obj.data.collections.new(MCH_COLLECTION)
        coll.is_visible = False
        for bn in driven_to_sources:
            b_data = arm_obj.data.bones.get(MCH_PREFIX + bn)
            if b_data is not None:
                coll.assign(b_data)

    created = 0
    for bn, dep_sources in driven_to_sources.items():
        mch_name = MCH_PREFIX + bn
        mch_pb = arm_obj.pose.bones.get(mch_name)
        tgt_pb = arm_obj.pose.bones.get(bn)
        if mch_pb is None or tgt_pb is None:
            continue

        mch_pb.rotation_mode = "QUATERNION"
        for axis in range(3):
            fc = mch_pb.driver_add("location", axis)
            d = fc.driver
            d.type = "SCRIPTED"
            _add_bone_rot_dep_vars(d, arm_obj, dep_sources)
            d.expression = f'wuwa_pd_eval("{arm_obj.name}", "{bn}", "loc", {axis})'
        for comp in range(4):
            fc = mch_pb.driver_add("rotation_quaternion", comp)
            d = fc.driver
            d.type = "SCRIPTED"
            _add_bone_rot_dep_vars(d, arm_obj, dep_sources)
            d.expression = f'wuwa_pd_eval("{arm_obj.name}", "{bn}", "quat", {comp})'

        con_loc = tgt_pb.constraints.new("COPY_LOCATION")
        con_loc.name = CONSTRAINT_LOC_NAME
        con_loc.target = arm_obj
        con_loc.subtarget = mch_name
        con_loc.use_offset = True
        con_loc.target_space = "LOCAL"
        con_loc.owner_space = "LOCAL"

        con_rot = tgt_pb.constraints.new("COPY_ROTATION")
        con_rot.name = CONSTRAINT_ROT_NAME
        con_rot.target = arm_obj
        con_rot.subtarget = mch_name
        con_rot.mix_mode = "BEFORE"
        con_rot.target_space = "LOCAL"
        con_rot.owner_space = "LOCAL"
        created += 1

    if prev_active:
        bpy.context.view_layer.objects.active = prev_active
        if prev_mode != "OBJECT":
            bpy.ops.object.mode_set(mode=prev_mode)

    return created


def apply_rbf_config(
    arm_obj: bpy.types.Object,
    cfg: dict[str, Any],
    solver_mode: str = "PRECOMPUTE",
    enable_rbf_morphs: bool = True,
    enable_pose_drivers: bool = True,
) -> dict[str, int]:
    register_driver_namespace()
    arm_obj[CONFIG_PROP] = json.dumps(cfg, separators=(",", ":"))
    arm_obj[SOLVER_PROP] = solver_mode.upper()
    _PARSED_CFG_CACHE.pop(arm_obj.name, None)
    _RBF_POSE_CACHE.pop(arm_obj.name, None)
    _PD_POSE_CACHE.pop(arm_obj.name, None)
    _get_armature_cfg(arm_obj)
    _ensure_embedded_runtime_text()

    meshes = find_bound_meshes(arm_obj)
    n_morph = _setup_rbf_shape_key_drivers(arm_obj, meshes, cfg) if enable_rbf_morphs else 0
    if not enable_rbf_morphs:
        _clear_rbf_drivers_on_meshes(meshes)

    n_pd = _setup_pose_driver_bones(arm_obj, cfg) if enable_pose_drivers else 0
    if not enable_pose_drivers:
        _clear_pose_drivers_on_armature(arm_obj)

    bpy.context.view_layer.update()
    return {"meshes": len(meshes), "morph_drivers": n_morph, "pose_driver_bones": n_pd}


def set_export_safe_mode(arm_obj: bpy.types.Object, export_safe: bool) -> dict[str, int]:
    """Mute/unmute drivers and constraints without deleting setup so FBX/glTF UE round-trip doesn't double-bake."""
    toggled_drivers = 0
    toggled_cons = 0

    for mesh_obj in find_bound_meshes(arm_obj):
        sk = mesh_obj.data.shape_keys
        if not sk or not sk.animation_data:
            continue
        for fc in sk.animation_data.drivers:
            if fc.driver and "wuwa_rbf_eval(" in fc.driver.expression:
                fc.mute = export_safe
                toggled_drivers += 1
                if export_safe and fc.data_path.startswith('key_blocks["') and fc.data_path.endswith('"].value'):
                    kname = fc.data_path[len('key_blocks["'):-len('"].value')]
                    kb = sk.key_blocks.get(kname)
                    if kb is not None:
                        kb.value = 0.0

    for pb in arm_obj.pose.bones:
        for cname in (CONSTRAINT_LOC_NAME, CONSTRAINT_ROT_NAME):
            con = pb.constraints.get(cname)
            if con is not None:
                con.mute = export_safe
                toggled_cons += 1

    bpy.context.view_layer.update()
    return {"drivers": toggled_drivers, "constraints": toggled_cons}


def bake_rbf_keyframes(arm_obj: bpy.types.Object, frame_start: int, frame_end: int) -> dict[str, int]:
    """Bake evaluated RBF shape key values to keyframes and mute live drivers."""
    meshes = find_bound_meshes(arm_obj)
    scene = bpy.context.scene
    prev_frame = scene.frame_current
    baked_keys = 0

    driven_per_mesh: list[tuple[bpy.types.Object, list[str]]] = []
    for mesh_obj in meshes:
        sk = mesh_obj.data.shape_keys
        if not sk or not sk.animation_data:
            continue
        names: list[str] = []
        for fc in sk.animation_data.drivers:
            if fc.driver and "wuwa_rbf_eval(" in fc.driver.expression:
                if fc.data_path.startswith('key_blocks["') and fc.data_path.endswith('"].value'):
                    names.append(fc.data_path[len('key_blocks["'):-len('"].value')])
        if names:
            driven_per_mesh.append((mesh_obj, names))

    cfg = _get_armature_cfg(arm_obj)
    if cfg is None:
        return {"frames": 0, "keys": 0}

    for frame in range(frame_start, frame_end + 1):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        weights = _evaluate_all_rbf_morphs(arm_obj, cfg)
        for mesh_obj, names in driven_per_mesh:
            sk = mesh_obj.data.shape_keys
            for kname in names:
                kb = sk.key_blocks.get(kname)
                if kb is not None:
                    kb.value = weights.get(kname, 0.0)
                    kb.keyframe_insert(data_path="value", frame=frame)
                    baked_keys += 1

    set_export_safe_mode(arm_obj, True)
    scene.frame_set(prev_frame)
    return {"frames": frame_end - frame_start + 1, "keys": baked_keys}


def fetch_rbf_config(server_url: str, character_id: str = "", mesh_path: str = "", skeleton_path: str = "") -> dict[str, Any]:
    params: dict[str, str] = {}
    if mesh_path.strip():
        params["meshPath"] = mesh_path.strip()
    if skeleton_path.strip():
        params["skeletonPath"] = skeleton_path.strip()
    if character_id.strip():
        params["characterId"] = character_id.strip()
    if not params:
        raise ValueError("Provide Character ID, Mesh Path, or Skeleton Path.")

    base = server_url.rstrip("/")
    url = f"{base}/api/rig/rbf?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {url}: {body}") from e


@persistent
def _on_load_post(_dummy: Any = None) -> None:
    register_driver_namespace()
    _PARSED_CFG_CACHE.clear()
    _RBF_POSE_CACHE.clear()
    _PD_POSE_CACHE.clear()
    _ANALYTIC_SOLVE_CACHE.clear()
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE" and CONFIG_PROP in obj:
            _get_armature_cfg(obj)


# ---------------------------------------------------------------------------
# Blender UI Addon Operators & N-Panel
# ---------------------------------------------------------------------------

class WuWaRbfSceneSettings(bpy.types.PropertyGroup):
    server_url: bpy.props.StringProperty(
        name="Server URL",
        default="http://localhost:5180",
        description="Running WuWaViewer.Server base URL",
    )
    character_id: bpy.props.StringProperty(
        name="Character ID",
        default="",
        description="e.g. FemaleMS/Daniya or Daniya",
    )
    mesh_path: bpy.props.StringProperty(
        name="Mesh Path",
        default="",
        description="Optional UE SkeletalMesh package path",
    )
    json_path: bpy.props.StringProperty(
        name="JSON File",
        default="",
        subtype="FILE_PATH",
        description="Saved JSON output from /api/rig/rbf",
    )
    solver_mode: bpy.props.EnumProperty(
        name="RBF Solver",
        items=[
            ("PRECOMPUTE", "Precompute LUT (Game Exact)", "Evaluate Kuro RBFPrecomputation lookup table with Analytic fallback"),
            ("ANALYTIC", "Analytic RBF", "Solve smooth spherical RBF directly from DriveSettings poses"),
        ],
        default="PRECOMPUTE",
    )
    apply_morphs: bpy.props.BoolProperty(name="Apply Corrective Morphs (RBFDrivers)", default=True)
    apply_pose_drivers: bpy.props.BoolProperty(name="Apply Skirt/Helper Bones (PoseDriver)", default=True)
    export_safe: bpy.props.BoolProperty(name="Export-Safe Muted", default=False)


class WUWA_OT_apply_rbf_server(bpy.types.Operator):
    bl_idname = "wuwa.apply_rbf_server"
    bl_label = "Fetch & Apply RBF Rig"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        arm = find_target_armature()
        if arm is None:
            self.report({"ERROR"}, "No Armature found in scene.")
            return {"CANCELLED"}
        s = context.scene.wuwa_rbf_settings
        char_id = s.character_id.strip()
        if not char_id and not s.mesh_path.strip():
            # Guess from armature name (e.g. R2T1DaniyaMd10011.ao -> Daniya or armature base)
            char_id = arm.name.split(".")[0]
        try:
            cfg = fetch_rbf_config(s.server_url, character_id=char_id, mesh_path=s.mesh_path)
            stats = apply_rbf_config(arm, cfg, s.solver_mode, s.apply_morphs, s.apply_pose_drivers)
            s.export_safe = False
        except Exception as ex:
            self.report({"ERROR"}, str(ex))
            return {"CANCELLED"}
        self.report({"INFO"}, f"Applied WuWa RBF Rig to {arm.name}: {stats['morph_drivers']} morph drivers, {stats['pose_driver_bones']} PoseDriver bones.")
        return {"FINISHED"}


class WUWA_OT_apply_rbf_file(bpy.types.Operator):
    bl_idname = "wuwa.apply_rbf_file"
    bl_label = "Apply from JSON File"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        arm = find_target_armature()
        if arm is None:
            self.report({"ERROR"}, "No Armature found in scene.")
            return {"CANCELLED"}
        s = context.scene.wuwa_rbf_settings
        path = bpy.path.abspath(s.json_path)
        if not path:
            self.report({"ERROR"}, "Select a /api/rig/rbf JSON file first.")
            return {"CANCELLED"}
        try:
            with open(path, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
            stats = apply_rbf_config(arm, cfg, s.solver_mode, s.apply_morphs, s.apply_pose_drivers)
            s.export_safe = False
        except Exception as ex:
            self.report({"ERROR"}, str(ex))
            return {"CANCELLED"}
        self.report({"INFO"}, f"Applied JSON RBF Rig: {stats['morph_drivers']} morph drivers, {stats['pose_driver_bones']} PoseDriver bones.")
        return {"FINISHED"}


class WUWA_OT_toggle_export_safe(bpy.types.Operator):
    bl_idname = "wuwa.toggle_export_safe"
    bl_label = "Toggle Export-Safe (Mute Drivers)"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        arm = find_target_armature()
        if arm is None:
            self.report({"ERROR"}, "No Armature found.")
            return {"CANCELLED"}
        s = context.scene.wuwa_rbf_settings
        new_state = not s.export_safe
        res = set_export_safe_mode(arm, new_state)
        s.export_safe = new_state
        state_str = "MUTED (Export-Safe)" if new_state else "ACTIVE"
        self.report({"INFO"}, f"WuWa RBF {state_str}: {res['drivers']} drivers, {res['constraints']} constraints.")
        return {"FINISHED"}


class WUWA_OT_bake_rbf_keyframes(bpy.types.Operator):
    bl_idname = "wuwa.bake_rbf_keyframes"
    bl_label = "Bake Morphs to Frame Range"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        arm = find_target_armature()
        if arm is None:
            self.report({"ERROR"}, "No Armature found.")
            return {"CANCELLED"}
        sc = context.scene
        res = bake_rbf_keyframes(arm, sc.frame_start, sc.frame_end)
        sc.wuwa_rbf_settings.export_safe = True
        self.report({"INFO"}, f"Baked {res['keys']} shape key values over {res['frames']} frames (drivers muted).")
        return {"FINISHED"}


class WUWA_OT_remove_rbf_rig(bpy.types.Operator):
    bl_idname = "wuwa.remove_rbf_rig"
    bl_label = "Remove WuWa RBF Setup"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        arm = find_target_armature()
        if arm is None:
            self.report({"ERROR"}, "No Armature found.")
            return {"CANCELLED"}
        res = remove_rbf_rig(arm)
        context.scene.wuwa_rbf_settings.export_safe = False
        self.report({"INFO"}, f"Removed {res['morph_drivers_removed']} morph drivers and {res['pose_driver_items_removed']} PoseDriver items.")
        return {"FINISHED"}


class WUWA_PT_rbf_panel(bpy.types.Panel):
    bl_label = "WuWa RBF & PoseDriver"
    bl_idname = "WUWA_PT_rbf_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "WuWa Rig"

    def draw(self, context):
        layout = self.layout
        s = context.scene.wuwa_rbf_settings
        arm = find_target_armature()

        box = layout.box()
        box.label(text=f"Target: {arm.name}" if arm else "Target: <No Armature>", icon="ARMATURE_DATA")
        box.prop(s, "solver_mode", text="Solver")
        box.prop(s, "apply_morphs")
        box.prop(s, "apply_pose_drivers")

        col = layout.box()
        col.label(text="Fetch from WuWaViewer.Server", icon="URL")
        col.prop(s, "server_url")
        col.prop(s, "character_id")
        col.prop(s, "mesh_path")
        col.operator("wuwa.apply_rbf_server", icon="MODIFIER")

        fbox = layout.box()
        fbox.label(text="Or Load Saved RBF JSON", icon="FILE_FOLDER")
        fbox.prop(s, "json_path", text="")
        fbox.operator("wuwa.apply_rbf_file", icon="IMPORT")

        utils = layout.box()
        utils.label(text="Round-Trip & Utilities", icon="EXPORT")
        utils.operator(
            "wuwa.toggle_export_safe",
            text="Resume Live Drivers" if s.export_safe else "Export-Safe Mute",
            icon="PLAY" if s.export_safe else "PAUSE",
        )
        utils.operator("wuwa.bake_rbf_keyframes", icon="KEYFRAME_HLT")
        utils.operator("wuwa.remove_rbf_rig", icon="TRASH")


_CLASSES = (
    WuWaRbfSceneSettings,
    WUWA_OT_apply_rbf_server,
    WUWA_OT_apply_rbf_file,
    WUWA_OT_toggle_export_safe,
    WUWA_OT_bake_rbf_keyframes,
    WUWA_OT_remove_rbf_rig,
    WUWA_PT_rbf_panel,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.wuwa_rbf_settings = bpy.props.PointerProperty(type=WuWaRbfSceneSettings)
    if _on_load_post not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_on_load_post)
    register_driver_namespace()


def unregister() -> None:
    if _on_load_post in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_on_load_post)
    if hasattr(bpy.types.Scene, "wuwa_rbf_settings"):
        del bpy.types.Scene.wuwa_rbf_settings
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)


# ---------------------------------------------------------------------------
# Headless / CLI Execution
# ---------------------------------------------------------------------------

def _parse_cli_args(argv: list[str]) -> dict[str, Any]:
    if "--" not in argv:
        return {}
    raw = argv[argv.index("--") + 1:]
    parsed: dict[str, Any] = {
        "glb": None,
        "json": None,
        "url": "http://localhost:5180",
        "character": "",
        "mesh": "",
        "skeleton": "",
        "armature": None,
        "solver": "PRECOMPUTE",
        "no_pose_drivers": False,
        "save": None,
        "verify": False,
    }
    i = 0
    while i < len(raw):
        arg = raw[i]
        if arg in ("--glb", "--json", "--url", "--character", "--mesh", "--skeleton", "--armature", "--solver", "--save") and i + 1 < len(raw):
            parsed[arg[2:]] = raw[i + 1]
            i += 2
        elif arg == "--no-pose-drivers":
            parsed["no_pose_drivers"] = True
            i += 1
        elif arg == "--verify":
            parsed["verify"] = True
            i += 1
        else:
            i += 1
    return parsed


def _run_cli() -> None:
    opts = _parse_cli_args(sys.argv)
    if not opts:
        try:
            register()
        except Exception:
            register_driver_namespace()
        return

    register_driver_namespace()
    if opts["glb"]:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=opts["glb"])

    arm = find_target_armature(opts["armature"])
    if arm is None:
        raise RuntimeError("No Armature found after import.")

    if opts["json"]:
        with open(opts["json"], "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    else:
        cfg = fetch_rbf_config(opts["url"], opts["character"], opts["mesh"], opts["skeleton"])

    stats = apply_rbf_config(
        arm,
        cfg,
        solver_mode=opts["solver"],
        enable_rbf_morphs=True,
        enable_pose_drivers=not opts["no_pose_drivers"],
    )
    print(f"[wuwa_rbf_rig] Applied to {arm.name}: {stats}")

    if opts["save"]:
        bpy.ops.wm.save_as_mainfile(filepath=opts["save"])
        print(f"[wuwa_rbf_rig] Saved {opts['save']}")


if __name__ == "__main__":
    _run_cli()
