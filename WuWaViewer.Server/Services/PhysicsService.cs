using System.Collections.Concurrent;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.Engine.Curves;
using CUE4Parse.UE4.Objects.UObject;
using WuWaViewer.Server.Models;

namespace WuWaViewer.Server.Services;

public sealed class PhysicsService(GameAssetService assets)
{
    private readonly ConcurrentDictionary<string, PhysicsConfigDto?> _cache = new(StringComparer.OrdinalIgnoreCase);

    public PhysicsConfigDto? GetCharacterPhysics(string characterId, string? preferredAbp = null)
    {
        var key = $"{characterId}::{preferredAbp}";
        if (_cache.TryGetValue(key, out var cached))
            return cached;

        var prefix = $"Client/Content/Aki/Character/Role/{characterId}/";
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(preferredAbp))
            candidates.Add(assets.NormalizePackagePath(preferredAbp));

        candidates.AddRange(assets.AllUAssets
            .Where(f => f.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
                        (Path.GetFileNameWithoutExtension(f).EndsWith("_PC", StringComparison.OrdinalIgnoreCase) ||
                         Path.GetFileNameWithoutExtension(f).StartsWith("ABP_", StringComparison.OrdinalIgnoreCase)))
            .Select(f => f[..^7])
            .OrderBy(p => p.Contains("Performance", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
            .ThenBy(p => p.Length));

        foreach (var cand in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var cfg = TryExtractFromAbp(characterId, cand);
            if (cfg != null && cfg.Groups.Count > 0)
            {
                _cache[key] = cfg;
                return cfg;
            }
        }

        _cache[key] = null;
        return null;
    }

    private PhysicsConfigDto? TryExtractFromAbp(string characterId, string abpPath)
    {
        if (!assets.TryLoadPackageSafe(abpPath, out var pkg))
            return null;

        var groups = new List<KawaiiGroupDto>();

        foreach (var expLazy in pkg.ExportsLazy)
        {
            var exp = expLazy.Value;
            foreach (var prop in exp.Properties)
            {
                var unwrapped = UnwrapStruct(prop.Tag?.GenericValue);
                if (unwrapped != null &&
                    prop.Name.Text.Contains("KawaiiPhysicsGroup", StringComparison.OrdinalIgnoreCase))
                {
                    var g = ParseKawaiiGroup(prop.Name.Text, unwrapped);
                    if (g != null) groups.Add(g);
                }
                else if (prop.Tag?.GenericValue is UScriptArray arr)
                {
                    foreach (var elem in arr.Properties)
                    {
                        var inner = UnwrapStruct(elem.GenericValue);
                        if (inner != null &&
                            inner.GetOrDefault<FStructFallback[]>("RootBones") is { Length: > 0 })
                        {
                            var g = ParseKawaiiGroup($"{prop.Name.Text}_{groups.Count}", inner);
                            if (g != null) groups.Add(g);
                        }
                    }
                }
            }
        }

        return groups.Count > 0 ? new PhysicsConfigDto(characterId, abpPath, groups) : null;
    }

    private KawaiiGroupDto? ParseKawaiiGroup(string name, FStructFallback s)
    {
        var rootBonesRaw = s.GetOrDefault<FStructFallback[]>("RootBones") ?? [];
        var rootBones = new List<string>();
        foreach (var rb in rootBonesRaw)
        {
            var bn = rb.GetOrDefault<FName>("BoneName").Text;
            if (!string.IsNullOrEmpty(bn) && !bn.Equals("None", StringComparison.OrdinalIgnoreCase))
                rootBones.Add(bn);
        }

        if (rootBones.Count == 0) return null;

        var excludeBonesRaw = s.GetOrDefault<FStructFallback[]>("ExcludeBones") ?? [];
        var excludeBones = excludeBonesRaw
            .Select(eb => eb.GetOrDefault<FName>("BoneName").Text)
            .Where(bn => !string.IsNullOrEmpty(bn) && !bn.Equals("None", StringComparison.OrdinalIgnoreCase))
            .ToList();

        var dummyLen = s.GetOrDefault("DummyBoneLength", 0f) * CoordConvert.UnitScale;
        var fwdAxis = s.GetOrDefault<FName>("BoneForwardAxis").Text;
        var planar = s.GetOrDefault<FName>("PlanarConstraint").Text;

        var ps = s.GetOrDefault<FStructFallback>("PhysicsSettings");
        var settings = ps != null
            ? new KawaiiSettingsDto(
                ps.GetOrDefault("Damping", 0.1f),
                ps.GetOrDefault("WorldDampingLocation", 0.8f),
                ps.GetOrDefault("WorldDampingRotation", 0.8f),
                ps.GetOrDefault("Stiffness", 0.05f),
                ps.GetOrDefault("Radius", 3.0f) * CoordConvert.UnitScale,
                ps.GetOrDefault("LimitAngle", 0f),
                ps.GetOrDefault("HalfWidth", 0f) * CoordConvert.UnitScale,
                ps.GetOrDefault<FName>("Shape").Text)
            : new KawaiiSettingsDto(0.1f, 0.8f, 0.8f, 0.05f, 0.03f, 0f, 0f, "Sphere");

        var grav = s.GetOrDefault("Gravity", FVector.ZeroVector);
        var gravScale = s.GetOrDefault("GravityScale", 1f);
        var enableWind = s.GetOrDefault("bEnableWind", false);
        var windScale = s.GetOrDefault("WindScale", 1f);
        var alpha = s.GetOrDefault("Alpha", 1f);

        var capsules = new List<KawaiiCapsuleLimitDto>();
        foreach (var cap in s.GetOrDefault<FStructFallback[]>("CapsuleLimits") ?? [])
        {
            var driving = cap.GetOrDefault<FStructFallback>("DrivingBone")?.GetOrDefault<FName>("BoneName").Text ?? "";
            if (string.IsNullOrEmpty(driving) || driving.Equals("None", StringComparison.OrdinalIgnoreCase)) continue;
            var offLoc = cap.GetOrDefault("OffsetLocation", FVector.ZeroVector);
            var offRot = cap.GetOrDefault("OffsetRotation", FRotator.ZeroRotator);
            var rad = cap.GetOrDefault("Radius", 5f) * CoordConvert.UnitScale;
            var len = cap.GetOrDefault("Length", 10f) * CoordConvert.UnitScale;
            capsules.Add(new KawaiiCapsuleLimitDto(
                driving,
                CoordConvert.SwapPos(offLoc),
                CoordConvert.SwapRotatorToQuat(offRot),
                rad,
                len));
        }

        var spheres = new List<KawaiiSphereLimitDto>();
        foreach (var sp in s.GetOrDefault<FStructFallback[]>("SphericalLimits") ?? [])
        {
            var driving = sp.GetOrDefault<FStructFallback>("DrivingBone")?.GetOrDefault<FName>("BoneName").Text ?? "";
            if (string.IsNullOrEmpty(driving) || driving.Equals("None", StringComparison.OrdinalIgnoreCase)) continue;
            var offLoc = sp.GetOrDefault("OffsetLocation", FVector.ZeroVector);
            var rad = sp.GetOrDefault("Radius", 5f) * CoordConvert.UnitScale;
            var limitType = sp.GetOrDefault<FName>("LimitType").Text;
            spheres.Add(new KawaiiSphereLimitDto(driving, CoordConvert.SwapPos(offLoc), rad, limitType));
        }

        var planars = new List<KawaiiPlanarLimitDto>();
        foreach (var pl in s.GetOrDefault<FStructFallback[]>("PlanarLimits") ?? [])
        {
            var driving = pl.GetOrDefault<FStructFallback>("DrivingBone")?.GetOrDefault<FName>("BoneName").Text ?? "";
            if (string.IsNullOrEmpty(driving) || driving.Equals("None", StringComparison.OrdinalIgnoreCase)) continue;
            var offLoc = pl.GetOrDefault("OffsetLocation", FVector.ZeroVector);
            var plane = pl.GetOrDefault<FStructFallback>("Plane");
            var normal = plane != null
                ? new FVector(plane.GetOrDefault("X", 0f), plane.GetOrDefault("Y", 0f), plane.GetOrDefault("Z", 1f))
                : new FVector(0, 0, 1);
            planars.Add(new KawaiiPlanarLimitDto(driving, CoordConvert.SwapPos(offLoc), CoordConvert.SwapVector(CoordConvert.NormalizeSafe(normal))));
        }

        return new KawaiiGroupDto(
            name,
            rootBones,
            excludeBones,
            dummyLen,
            fwdAxis,
            planar,
            settings,
            CoordConvert.SwapPos(grav),
            gravScale,
            enableWind,
            windScale,
            alpha,
            ParseRuntimeCurve(s.GetOrDefault<FStructFallback>("DampingCurveData")),
            ParseRuntimeCurve(s.GetOrDefault<FStructFallback>("StiffnessCurveData")),
            ParseRuntimeCurve(s.GetOrDefault<FStructFallback>("RadiusCurveData")),
            ParseRuntimeCurve(s.GetOrDefault<FStructFallback>("LimitAngleCurveData")),
            capsules,
            spheres,
            planars);
    }

    private KawaiiCurveSampleDto? ParseRuntimeCurve(FStructFallback? data)
    {
        if (data == null) return null;
        var ext = data.GetOrDefault<FPackageIndex>("ExternalCurve");
        if (ext?.TryLoad<UCurveFloat>(out var curveAsset) == true &&
            curveAsset.GetOrDefault<FRichCurve>("FloatCurve") is { Keys.Length: > 0 } rich)
        {
            var keys = rich.Keys;
            return new KawaiiCurveSampleDto(
                true,
                keys.Select(k => k.Time).ToArray(),
                keys.Select(k => k.Value).ToArray());
        }

        var editorCurve = data.GetOrDefault<FRichCurve>("EditorCurveData");
        if (editorCurve?.Keys is { Length: > 0 } eKeys)
        {
            return new KawaiiCurveSampleDto(
                true,
                eKeys.Select(k => k.Time).ToArray(),
                eKeys.Select(k => k.Value).ToArray());
        }

        return null;
    }

    private static FStructFallback? UnwrapStruct(object? val) => val switch
    {
        FStructFallback sf => sf,
        FScriptStruct ss => ss.StructType as FStructFallback,
        _ => null
    };
}
