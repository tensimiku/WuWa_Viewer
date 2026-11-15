using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.Engine.Animation;
using CUE4Parse.UE4.Objects.Engine.Curves;
using CUE4Parse.UE4.Objects.UObject;
using WuWaViewer.Server.Models;

namespace WuWaViewer.Server.Services;

public sealed class RbfService(GameAssetService assets, ILogger<RbfService> logger)
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private readonly ConcurrentDictionary<string, RigRbfConfigDto?> _memCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.OrdinalIgnoreCase);

    public async Task<RigRbfConfigDto?> GetRigRbfConfigAsync(
        string? meshPath = null,
        string? skeletonPath = null,
        string? characterId = null,
        string? preferredAbp = null)
    {
        var key = $"{meshPath?.Trim() ?? ""}::{skeletonPath?.Trim() ?? ""}::{characterId?.Trim() ?? ""}::{preferredAbp?.Trim() ?? ""}";
        if (_memCache.TryGetValue(key, out var hit))
            return hit;

        var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync();
        try
        {
            if (_memCache.TryGetValue(key, out hit))
                return hit;

            var hashKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key.ToLowerInvariant())))[..24];
            var cachePath = assets.GetCacheFilePath("rbf", hashKey, "json");
            if (File.Exists(cachePath))
            {
                try
                {
                    var json = await File.ReadAllTextAsync(cachePath);
                    var parsed = JsonSerializer.Deserialize<RigRbfConfigDto>(json, JsonOpts);
                    if (parsed != null)
                    {
                        _memCache[key] = parsed;
                        return parsed;
                    }
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Corrupt RBF cache ignored: {Path}", cachePath);
                }
            }

            var built = BuildConfig(meshPath, skeletonPath, characterId, preferredAbp);
            if (built != null)
            {
                var tmpPath = $"{cachePath}.{Guid.NewGuid():N}.tmp";
                var dir = Path.GetDirectoryName(cachePath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                await File.WriteAllTextAsync(tmpPath, JsonSerializer.Serialize(built, JsonOpts));
                File.Move(tmpPath, cachePath, overwrite: true);
            }

            _memCache[key] = built;
            return built;
        }
        finally
        {
            gate.Release();
        }
    }

    private RigRbfConfigDto? BuildConfig(string? meshPath, string? skeletonPath, string? characterId, string? preferredAbp)
    {
        string? normMesh = string.IsNullOrWhiteSpace(meshPath) ? null : assets.NormalizePackagePath(meshPath);
        string? normSkel = string.IsNullOrWhiteSpace(skeletonPath) ? null : assets.NormalizePackagePath(skeletonPath);
        string? resolvedCharId = string.IsNullOrWhiteSpace(characterId) ? null : characterId.Trim();
        string? variantHint = null;

        if (normMesh != null)
        {
            var skMesh = assets.LoadObjectSafe<USkeletalMesh>(normMesh);
            if (skMesh?.Skeleton?.ResolvedObject?.GetPathName() is { } skPath && !string.IsNullOrWhiteSpace(skPath))
                normSkel ??= assets.NormalizePackagePath(skPath);

            TryExtractRoleAndVariant(normMesh, ref resolvedCharId, ref variantHint);
        }

        if (normSkel != null)
            TryExtractRoleAndVariant(normSkel, ref resolvedCharId, ref variantHint);

        if (normSkel == null && !string.IsNullOrWhiteSpace(resolvedCharId))
            (normSkel, resolvedCharId, variantHint) = FindSkeletonForCharacter(resolvedCharId!, variantHint);

        if (normSkel == null || !assets.TryLoadPackageSafe(normSkel, out var skelPkg))
            return null;

        var exports = skelPkg.ExportsLazy.Select(e => e.Value).ToList();
        var skel = exports.OfType<USkeleton>().FirstOrDefault();
        if (skel == null)
            return null;

        var refInfos = skel.ReferenceSkeleton.FinalRefBoneInfo ?? [];
        var refPoses = skel.ReferenceSkeleton.FinalRefBonePose ?? [];
        var boneIndexByName = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var compPoses = new FTransform[refInfos.Length];
        for (int i = 0; i < refInfos.Length; i++)
        {
            boneIndexByName[refInfos[i].Name.Text] = i;
            var pIdx = refInfos[i].ParentIndex;
            compPoses[i] = pIdx >= 0 && pIdx < i ? refPoses[i] * compPoses[pIdx] : refPoses[i];
        }

        string? precompPath = null;
        Dictionary<string, RbfPrecomputationTableDto>? precompTables = null;
        var precompIdx = skel.Properties.FirstOrDefault(p => p.Name.Text == "Precomputations")?.Tag?.GenericValue as FPackageIndex;
        if (precompIdx?.ResolvedObject?.GetPathName() is { } pcPath && !string.IsNullOrWhiteSpace(pcPath))
        {
            precompPath = assets.NormalizePackagePath(pcPath);
            precompTables = LoadPrecomputationTables(precompPath);
        }

        var rbfExports = ResolveOrderedRbfDriverExports(skel, exports);
        var rbfDrivers = new List<SkeletonRbfDriverDto>(rbfExports.Count);
        for (int idx = 0; idx < rbfExports.Count; idx++)
        {
            var dto = ParseRbfDriver(idx, rbfExports[idx], refInfos, compPoses, boneIndexByName, precompTables);
            if (dto != null)
                rbfDrivers.Add(dto);
        }

        var (sourceAbp, poseDrivers) = ExtractPoseDrivers(resolvedCharId, variantHint, preferredAbp, refInfos, refPoses, compPoses, boneIndexByName);

        return new RigRbfConfigDto(
            normSkel,
            normMesh,
            resolvedCharId,
            precompPath,
            sourceAbp,
            rbfDrivers,
            poseDrivers);
    }

    private (string? SkelPath, string? CharId, string? VariantHint) FindSkeletonForCharacter(string charInput, string? variantHint)
    {
        var matchedKey = assets.CharacterMap.Keys.FirstOrDefault(k => k.Equals(charInput, StringComparison.OrdinalIgnoreCase))
            ?? assets.CharacterMap.Keys.FirstOrDefault(k => k.EndsWith("/" + charInput, StringComparison.OrdinalIgnoreCase))
            ?? assets.CharacterMap.Keys.FirstOrDefault(k => k.Contains(charInput, StringComparison.OrdinalIgnoreCase));

        var resolvedChar = matchedKey ?? charInput;
        var prefix = $"Client/Content/Aki/Character/Role/{resolvedChar}/";
        var skelFile = assets.AllUAssets
            .Where(f => f.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
                        f.EndsWith("_Skeleton.uasset", StringComparison.OrdinalIgnoreCase) &&
                        !f.Contains("/Weapon/", StringComparison.OrdinalIgnoreCase))
            .OrderBy(f => f.Contains("Performance", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
            .ThenBy(f => f.Length)
            .FirstOrDefault();

        if (skelFile == null) return (null, resolvedChar, variantHint);
        var norm = skelFile[..^7];
        TryExtractRoleAndVariant(norm, ref resolvedChar, ref variantHint);
        return (norm, resolvedChar, variantHint);
    }

    private static void TryExtractRoleAndVariant(string normPath, ref string? charId, ref string? variantHint)
    {
        const string roleRoot = "Client/Content/Aki/Character/Role/";
        if (!normPath.StartsWith(roleRoot, StringComparison.OrdinalIgnoreCase)) return;
        var rel = normPath[roleRoot.Length..].Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (rel.Length >= 2 && string.IsNullOrWhiteSpace(charId))
            charId = $"{rel[0]}/{rel[1]}";
        if (rel.Length >= 3 && string.IsNullOrWhiteSpace(variantHint))
            variantHint = rel[2];
    }

    private Dictionary<string, RbfPrecomputationTableDto>? LoadPrecomputationTables(string precompPath)
    {
        if (!assets.TryLoadPackageSafe(precompPath, out var pkg))
            return null;

        var exp = pkg.ExportsLazy.Select(x => x.Value).FirstOrDefault();
        if (exp?.Properties.FirstOrDefault(p => p.Name.Text == "Precomputations")?.Tag?.GenericValue is not UScriptMap mp)
            return null;

        var dict = new Dictionary<string, RbfPrecomputationTableDto>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in mp.Properties)
        {
            var drvName = kv.Key?.GenericValue?.ToString();
            var sf = UnwrapStruct(kv.Value?.GenericValue);
            if (string.IsNullOrWhiteSpace(drvName) || sf == null) continue;

            float lx = sf.GetOrDefault<float>("RotationLimitX");
            float ly = sf.GetOrDefault<float>("RotationLimitY");
            float lz = sf.GetOrDefault<float>("RotationLimitZ");
            float interval = MathF.Max(0.001f, sf.GetOrDefault("Interval", 4.0f));
            var preWeights = sf.GetOrDefault<FStructFallback[]>("PreWeights") ?? [];
            if (preWeights.Length == 0) continue;

            int ny = ly > 0 ? (int)Math.Round(2f * ly / interval) + 1 : 1;
            int nz = lz > 0 ? (int)Math.Round(2f * lz / interval) + 1 : 1;
            var rows = new float[preWeights.Length][];
            for (int i = 0; i < preWeights.Length; i++)
                rows[i] = preWeights[i].GetOrDefault<float[]>("Data") ?? [];

            dict[drvName] = new RbfPrecomputationTableDto(lx, ly, lz, interval, ny, nz, rows);
        }

        return dict;
    }

    private static List<UObject> ResolveOrderedRbfDriverExports(USkeleton skel, List<UObject> exports)
    {
        var rbfByName = exports
            .Where(e => e.ExportType.Equals("RBFDriver", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(e => e.Name, e => e, StringComparer.OrdinalIgnoreCase);

        var ordered = new List<UObject>();
        var drvArray = skel.Properties.FirstOrDefault(p => p.Name.Text == "RBFDrivers")?.Tag?.GenericValue as UScriptArray;
        if (drvArray != null)
        {
            foreach (var elem in drvArray.Properties)
            {
                if (elem.GenericValue is FPackageIndex pi && pi.ResolvedObject?.Name.Text is { } expName &&
                    rbfByName.TryGetValue(expName, out var matched))
                {
                    ordered.Add(matched);
                }
            }
        }

        if (ordered.Count == 0)
            ordered.AddRange(rbfByName.Values);

        return ordered;
    }

    private SkeletonRbfDriverDto? ParseRbfDriver(
        int index,
        UObject exp,
        FMeshBoneInfo[] refInfos,
        FTransform[] compPoses,
        Dictionary<string, int> boneIndexByName,
        Dictionary<string, RbfPrecomputationTableDto>? precompTables)
    {
        var driverName = exp.GetOrDefault<FName>("DriverName").Text;
        var driverBone = exp.GetOrDefault<FName>("DriverBoneName").Text;
        var baseBone = exp.GetOrDefault<FName>("BaseBoneName").Text;
        if (string.IsNullOrWhiteSpace(driverBone) || string.IsNullOrWhiteSpace(baseBone))
            return null;

        float[] basePos = [0f, 0f, 0f];
        float[] baseQuat = [0f, 0f, 0f, 1f];
        float[] drvPos = [0f, 0f, 0f];
        string? baseParent = null;

        if (boneIndexByName.TryGetValue(baseBone, out var baseIdx))
        {
            var bXf = compPoses[baseIdx];
            basePos = VecArray(bXf.Translation);
            baseQuat = QuatArray(bXf.Rotation);
            var pIdx = refInfos[baseIdx].ParentIndex;
            if (pIdx >= 0 && pIdx < refInfos.Length)
                baseParent = refInfos[pIdx].Name.Text;
        }
        if (boneIndexByName.TryGetValue(driverBone, out var drvIdx))
            drvPos = VecArray(compPoses[drvIdx].Translation);

        var dx = drvPos[0] - basePos[0];
        var dy = drvPos[1] - basePos[1];
        var dz = drvPos[2] - basePos[2];
        var radiusCm = MathF.Sqrt(dx * dx + dy * dy + dz * dz);

        var attrsRaw = exp.Properties.FirstOrDefault(p => p.Name.Text == "DriverAttributes")?.Tag?.GenericValue as UScriptArray;
        var attrs = attrsRaw?.Properties
            .Select(p => StripEnumPrefix(p.GenericValue?.ToString()))
            .Where(s => !string.IsNullOrEmpty(s))
            .ToArray() ?? [];

        var morphs = (exp.GetOrDefault<FName[]>("DrivenMorphTargets") ?? [])
            .Select(m => m.Text)
            .ToArray();

        RbfWeightModifierDto? modifier = null;
        var modSf = UnwrapStruct(exp.Properties.FirstOrDefault(p => p.Name.Text == "WeightModifier")?.Tag?.GenericValue);
        if (modSf != null)
        {
            var srcWeight = modSf.GetOrDefault<FName>("SrcWeight").Text;
            var dstIdx = modSf.GetOrDefault<int>("DstDriverIndex");
            var dstWeight = modSf.GetOrDefault<FName>("DstWeight").Text;
            var curveKeys = ReadCurveKeys(modSf.GetOrDefault<FStructFallback>("FactorCurve"));
            if (!string.IsNullOrWhiteSpace(srcWeight) && !string.IsNullOrWhiteSpace(dstWeight) &&
                !srcWeight.Equals("None", StringComparison.OrdinalIgnoreCase))
            {
                modifier = new RbfWeightModifierDto(srcWeight, dstIdx, dstWeight, curveKeys);
            }
        }

        var driveSettings = new List<RbfPoseTargetDto>();
        var dsRaw = exp.GetOrDefault<FStructFallback[]>("DriveSettings") ?? [];
        foreach (var entry in dsRaw)
        {
            var dp = entry.GetOrDefault<FStructFallback[]>("DriverPoses") ?? [];
            var vals = dp.Select(p => p.GetOrDefault<float>("Value")).ToArray();
            var weights = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
            var dw = entry.GetOrDefault<FStructFallback[]>("DrivenWeights") ?? [];
            foreach (var w in dw)
            {
                var mn = w.GetOrDefault<FName>("Name").Text;
                if (!string.IsNullOrWhiteSpace(mn))
                    weights[mn] = w.GetOrDefault<float>("Value");
            }
            driveSettings.Add(new RbfPoseTargetDto(vals, weights));
        }

        RbfPrecomputationTableDto? preTable = null;
        if (precompTables != null && !string.IsNullOrWhiteSpace(driverName))
            precompTables.TryGetValue(driverName, out preTable);

        return new SkeletonRbfDriverDto(
            index,
            driverName,
            driverBone,
            baseBone,
            baseParent,
            basePos,
            baseQuat,
            drvPos,
            radiusCm,
            attrs,
            morphs,
            modifier,
            driveSettings,
            preTable);
    }

    private (string? SourceAbp, List<PoseDriverNodeDto> PoseDrivers) ExtractPoseDrivers(
        string? charId,
        string? variantHint,
        string? preferredAbp,
        FMeshBoneInfo[] refInfos,
        FTransform[] refPoses,
        FTransform[] compPoses,
        Dictionary<string, int> boneIndexByName)
    {
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(preferredAbp))
            candidates.Add(assets.NormalizePackagePath(preferredAbp));

        if (!string.IsNullOrWhiteSpace(charId))
        {
            var prefix = $"Client/Content/Aki/Character/Role/{charId}/";
            candidates.AddRange(assets.AllUAssets
                .Where(f => f.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
                            (Path.GetFileNameWithoutExtension(f).EndsWith("_PC", StringComparison.OrdinalIgnoreCase) ||
                             Path.GetFileNameWithoutExtension(f).StartsWith("ABP_", StringComparison.OrdinalIgnoreCase)))
                .Select(f => f[..^7])
                .OrderBy(p => variantHint != null && p.Contains(variantHint, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ThenBy(p => p.Contains("Performance", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
                .ThenBy(p => p.Length));
        }

        foreach (var cand in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!assets.TryLoadPackageSafe(cand, out var pkg))
                continue;

            var nodes = new List<PoseDriverNodeDto>();
            foreach (var expLazy in pkg.ExportsLazy)
            {
                var exp = expLazy.Value;
                foreach (var prop in exp.Properties)
                {
                    if (!prop.Name.Text.StartsWith("AnimGraphNode_PoseDriver", StringComparison.OrdinalIgnoreCase))
                        continue;

                    var nodeSf = UnwrapStruct(prop.Tag?.GenericValue);
                    if (nodeSf == null) continue;

                    var dto = ParsePoseDriverNode(prop.Name.Text, nodeSf, refInfos, refPoses, compPoses, boneIndexByName);
                    if (dto != null)
                        nodes.Add(dto);
                }
            }

            if (nodes.Count > 0)
                return (cand, nodes);
        }

        return (candidates.FirstOrDefault(), []);
    }

    private PoseDriverNodeDto? ParsePoseDriverNode(
        string nodeName,
        FStructFallback nodeSf,
        FMeshBoneInfo[] refInfos,
        FTransform[] refPoses,
        FTransform[] compPoses,
        Dictionary<string, int> boneIndexByName)
    {
        var sourceBonesRaw = nodeSf.GetOrDefault<FStructFallback[]>("SourceBones") ?? [];
        var sourceBone = sourceBonesRaw
            .Select(b => b.GetOrDefault<FName>("BoneName").Text)
            .FirstOrDefault(n => !string.IsNullOrWhiteSpace(n) && !n.Equals("None", StringComparison.OrdinalIgnoreCase));

        if (string.IsNullOrWhiteSpace(sourceBone) || !boneIndexByName.TryGetValue(sourceBone, out var srcIdx))
            return null;

        var srcParentIdx = refInfos[srcIdx].ParentIndex;
        var srcParentName = srcParentIdx >= 0 && srcParentIdx < refInfos.Length ? refInfos[srcParentIdx].Name.Text : null;
        var srcCompQuat = QuatArray(compPoses[srcIdx].Rotation);
        var srcLocalQuat = QuatArray(refPoses[srcIdx].Rotation);

        var onlyDriveBones = (nodeSf.GetOrDefault<FStructFallback[]>("OnlyDriveBones") ?? [])
            .Select(b => b.GetOrDefault<FName>("BoneName").Text)
            .Where(n => !string.IsNullOrWhiteSpace(n) && !n.Equals("None", StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        bool onlySelected = nodeSf.GetOrDefault("bOnlyDriveSelectedBones", true);

        var rbfParams = UnwrapStruct(nodeSf.Properties.FirstOrDefault(p => p.Name.Text == "RBFParams")?.Tag?.GenericValue);
        var solverType = StripEnumPrefix(rbfParams?.GetOrDefault<FName>("SolverType").Text ?? "Additive");
        var functionType = StripEnumPrefix(rbfParams?.GetOrDefault<FName>("Function").Text ?? "Gaussian");
        var distMethod = StripEnumPrefix(rbfParams?.GetOrDefault<FName>("DistanceMethod").Text ?? "Quaternion");
        var radius = rbfParams?.GetOrDefault("Radius", 22.5f) ?? 22.5f;
        var autoRadius = rbfParams?.GetOrDefault("bAutomaticRadius", false) ?? false;
        var weightThreshold = rbfParams?.GetOrDefault("WeightThreshold", 0.0001f) ?? 0.0001f;
        var normalizeMethod = StripEnumPrefix(rbfParams?.GetOrDefault<FName>("NormalizeMethod").Text ?? "AlwaysNormalize");

        var poseAssetIdx = nodeSf.GetOrDefault<FPackageIndex>("PoseAsset");
        var rawPoseAssetPath = poseAssetIdx?.ResolvedObject?.GetPathName();
        if (string.IsNullOrWhiteSpace(rawPoseAssetPath))
            return null;

        var poseAssetPath = assets.NormalizePackagePath(rawPoseAssetPath);
        var poseAsset = assets.LoadObjectSafe<UPoseAsset>(poseAssetPath);
        if (poseAsset == null)
            return null;

        var pc = poseAsset.PoseContainer;
        var poseNames = pc.PoseFNames?.Length > 0
            ? pc.PoseFNames.Select(n => n.Text).ToArray()
            : (pc.PoseNames_DEPRECATED?.Select(n => n.DisplayName.Text).ToArray() ?? []);
        var tracks = pc.Tracks ?? [];
        var poseMap = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < poseNames.Length; i++)
        {
            if (!string.IsNullOrWhiteSpace(poseNames[i]))
                poseMap[poseNames[i]] = i;
        }

        var onlyDriveSet = new HashSet<string>(onlyDriveBones, StringComparer.OrdinalIgnoreCase);
        var localRestQuats = new Dictionary<string, float[]>(StringComparer.OrdinalIgnoreCase);
        var compRestQuats = new Dictionary<string, float[]>(StringComparer.OrdinalIgnoreCase);
        var parentCompRestQuats = new Dictionary<string, float[]>(StringComparer.OrdinalIgnoreCase);

        void RecordBoneRest(string bn)
        {
            if (localRestQuats.ContainsKey(bn) || !boneIndexByName.TryGetValue(bn, out var bi)) return;
            localRestQuats[bn] = QuatArray(refPoses[bi].Rotation);
            compRestQuats[bn] = QuatArray(compPoses[bi].Rotation);
            var pi = refInfos[bi].ParentIndex;
            parentCompRestQuats[bn] = pi >= 0 && pi < compPoses.Length
                ? QuatArray(compPoses[pi].Rotation)
                : [0f, 0f, 0f, 1f];
        }

        RecordBoneRest(sourceBone);

        var poses = new List<PoseDriverPoseDto>();
        var poseTargetsRaw = nodeSf.GetOrDefault<FStructFallback[]>("PoseTargets") ?? [];
        foreach (var pt in poseTargetsRaw)
        {
            var drivenName = pt.GetOrDefault<FName>("DrivenName").Text;
            var targetScale = pt.GetOrDefault("TargetScale", 1.0f);
            var isHidden = pt.GetOrDefault("bIsHidden", false);

            var bts = pt.GetOrDefault<FStructFallback[]>("BoneTransforms") ?? [];
            var rot = ReadRotator(bts.Length > 0 ? bts[0] : pt, "TargetRotation");

            var targetQuat = rot.Quaternion();
            var drivenBones = new List<PoseAssetBoneDeltaDto>();

            if (!string.IsNullOrWhiteSpace(drivenName) &&
                poseMap.TryGetValue(drivenName, out var pIdx) &&
                pc.Poses != null && pIdx >= 0 && pIdx < pc.Poses.Length)
            {
                var pd = pc.Poses[pIdx];
                if (pd.TrackToBufferIndex != null && pd.LocalSpacePose != null)
                {
                    foreach (var kv in pd.TrackToBufferIndex)
                    {
                        if (kv.Key < 0 || kv.Key >= tracks.Length || kv.Value < 0 || kv.Value >= pd.LocalSpacePose.Length)
                            continue;

                        var boneName = tracks[kv.Key].Text;
                        if (onlySelected && onlyDriveSet.Count > 0 && !onlyDriveSet.Contains(boneName))
                            continue;

                        var xf = pd.LocalSpacePose[kv.Value];
                        var t = xf.Translation;
                        var q = xf.Rotation;
                        bool hasDelta = MathF.Abs(t.X) > 1e-4f || MathF.Abs(t.Y) > 1e-4f || MathF.Abs(t.Z) > 1e-4f ||
                                        MathF.Abs(MathF.Abs(q.W) - 1.0f) > 1e-5f;
                        if (!hasDelta) continue;

                        RecordBoneRest(boneName);
                        drivenBones.Add(new PoseAssetBoneDeltaDto(boneName, VecArray(t), QuatArray(q)));
                    }
                }
            }

            poses.Add(new PoseDriverPoseDto(
                drivenName,
                [rot.Pitch, rot.Yaw, rot.Roll],
                QuatArray(targetQuat),
                targetScale,
                isHidden,
                drivenBones));
        }

        return new PoseDriverNodeDto(
            nodeName,
            sourceBone,
            srcParentName,
            srcCompQuat,
            srcLocalQuat,
            onlyDriveBones,
            solverType,
            functionType,
            distMethod,
            radius,
            autoRadius,
            weightThreshold,
            normalizeMethod,
            poseAssetPath,
            poseAsset.bAdditivePose,
            localRestQuats,
            compRestQuats,
            parentCompRestQuats,
            poses);
    }

    private RbfCurveKeyDto[] ReadCurveKeys(FStructFallback? runtimeFloatCurve)
    {
        if (runtimeFloatCurve == null) return [];
        var ext = runtimeFloatCurve.GetOrDefault<FPackageIndex>("ExternalCurve");
        if (ext?.ResolvedObject?.GetPathName() is { } extPath &&
            assets.LoadObjectSafe<UCurveFloat>(extPath) is { } curveAsset &&
            curveAsset.GetOrDefault<FRichCurve>("FloatCurve") is { Keys.Length: > 0 } extRich)
        {
            return extRich.Keys.Select(k => new RbfCurveKeyDto(k.Time, k.Value)).ToArray();
        }

        var ed = runtimeFloatCurve.GetOrDefault<FRichCurve>("EditorCurveData");
        if (ed?.Keys is { Length: > 0 } keys)
            return keys.Select(k => new RbfCurveKeyDto(k.Time, k.Value)).ToArray();

        return [];
    }

    private static FRotator ReadRotator(FStructFallback owner, string propName)
    {
        var raw = owner.Properties.FirstOrDefault(p => p.Name.Text == propName)?.Tag?.GenericValue;
        if (raw is FRotator r) return r;
        var sf = UnwrapStruct(raw);
        if (sf != null)
            return new FRotator(sf.GetOrDefault<float>("Pitch"), sf.GetOrDefault<float>("Yaw"), sf.GetOrDefault<float>("Roll"));
        return owner.GetOrDefault<FRotator>(propName);
    }

    private static string StripEnumPrefix(string? val)
    {
        if (string.IsNullOrWhiteSpace(val)) return "";
        var idx = val.IndexOf("::", StringComparison.Ordinal);
        return idx >= 0 ? val[(idx + 2)..] : val;
    }

    private static float[] VecArray(FVector v) => [v.X, v.Y, v.Z];

    private static float[] QuatArray(FQuat q) => [q.X, q.Y, q.Z, q.W];

    private static FStructFallback? UnwrapStruct(object? val) => val switch
    {
        FStructFallback sf => sf,
        FScriptStruct ss => ss.StructType as FStructFallback,
        _ => null
    };
}
