using System.Collections.Concurrent;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse_Conversion.Animations;
using CUE4Parse_Conversion.Writers.ActorX.Structs.Animations;
using Newtonsoft.Json;
using WuWaViewer.Server.Models;

namespace WuWaViewer.Server.Services;

public sealed class AnimationService(GameAssetService assets, ILogger<AnimationService> logger)
{
    private readonly ConcurrentDictionary<string, AnimationPayloadDto> _animCache = new(StringComparer.OrdinalIgnoreCase);

    public async Task<AnimationPayloadDto?> GetAnimationAsync(string animPath, string? ribbonPath = null)
    {
        var norm = assets.NormalizePackagePath(animPath);
        var normRib = string.IsNullOrWhiteSpace(ribbonPath) ? null : assets.NormalizePackagePath(ribbonPath);
        var cacheKey = normRib == null ? norm : $"{norm}||{normRib}";

        if (_animCache.TryGetValue(cacheKey, out var cached))
            return cached;

        var cacheFile = assets.GetCacheFilePath("anim", cacheKey, "json");
        if (File.Exists(cacheFile))
        {
            var fromDisk = JsonConvert.DeserializeObject<AnimationPayloadDto>(await File.ReadAllTextAsync(cacheFile));
            if (fromDisk != null)
            {
                _animCache[cacheKey] = fromDisk;
                return fromDisk;
            }
        }

        var payload = BuildAnimationPayload(norm, isRibbonLayer: false);
        if (payload == null) return null;

        AnimationPayloadDto? ribPayload = null;
        if (normRib != null)
            ribPayload = BuildAnimationPayload(normRib, isRibbonLayer: true);

        var combined = payload with { RibbonLayer = ribPayload };
        await File.WriteAllTextAsync(cacheFile, JsonConvert.SerializeObject(combined));
        _animCache[cacheKey] = combined;
        return combined;
    }

    private AnimationPayloadDto? BuildAnimationPayload(string norm, bool isRibbonLayer)
    {
        var obj = assets.LoadObjectSafe<UAnimationAsset>(norm);
        if (obj == null) return null;

        var skel = obj.Skeleton?.Load<USkeleton>();
        if (skel == null)
        {
            logger.LogWarning("Animation {Path} has no skeleton", norm);
            return null;
        }

        var segments = new List<AnimSegmentPayloadDto>();
        string kind;
        float totalDuration;

        if (obj is UAnimMontage montage)
        {
            kind = "Montage";
            var animSet = skel.ConvertAnims(montage);
            totalDuration = animSet.TotalAnimTime > 0 ? animSet.TotalAnimTime : montage.CalculateSequenceLength();

            foreach (var cSeq in animSet.Sequences)
            {
                segments.Add(BuildSegmentDto(
                    cSeq,
                    skel,
                    cSeq.SlotName ?? "DefaultSlot",
                    cSeq.StartPos,
                    cSeq.AnimEndTime,
                    playRate: 1f,
                    cSeq.LoopingCount,
                    isRibbonLayer));
            }
        }
        else if (obj is UAnimSequence seq)
        {
            kind = "Sequence";
            var animSet = skel.ConvertAnims(seq);
            var cSeq = animSet.Sequences.FirstOrDefault();
            if (cSeq == null) return null;

            totalDuration = seq.SequenceLength > 0 ? seq.SequenceLength : cSeq.AnimEndTime;
            segments.Add(BuildSegmentDto(
                cSeq,
                skel,
                "DefaultSlot",
                0f,
                totalDuration,
                seq.RateScale != 0f ? seq.RateScale : 1f,
                1,
                isRibbonLayer));
        }
        else
        {
            return null;
        }

        return new AnimationPayloadDto(
            norm,
            obj.Name,
            kind,
            totalDuration,
            skel.Name,
            segments,
            null);
    }

    private static AnimSegmentPayloadDto BuildSegmentDto(
        CAnimSequence cSeq,
        USkeleton skel,
        string slotName,
        float startTime,
        float endTime,
        float playRate,
        int loopingCount,
        bool isRibbonLayer)
    {
        var orig = cSeq.OriginalSequence;
        var boneInfos = skel.ReferenceSkeleton.FinalRefBoneInfo;
        var boneTree = skel.BoneTree ?? [];
        var isAdditive = orig.IsValidAdditive();
        var hasRefPoseSeq = orig.RefPoseSeq != null;

        var tracks = new List<AnimBoneTrackDto>(cSeq.Tracks.Count);
        for (int i = 0; i < cSeq.Tracks.Count && i < boneInfos.Length; i++)
        {
            var boneName = boneInfos[i].Name.Text;
            var mode = i < boneTree.Length ? boneTree[i].ToString() : "Skeleton";
            var cTrack = cSeq.Tracks[i];

            bool hasExplicit = orig.FindTrackForBoneIndex(i) >= 0;

            // For ribbon layer: skip tracks that are NOT explicitly authored in Rib_* (or standard body skeleton unless explicitly ribbon/physics animated)
            if (isRibbonLayer && !hasExplicit && !IsLikelySecondaryBone(boneName))
                continue;

            var posKeys = new float[cTrack.KeyPos.Length * 3];
            for (int k = 0; k < cTrack.KeyPos.Length; k++)
            {
                var sw = CoordConvert.SwapPos(cTrack.KeyPos[k]);
                posKeys[k * 3 + 0] = sw[0];
                posKeys[k * 3 + 1] = sw[1];
                posKeys[k * 3 + 2] = sw[2];
            }

            var quatKeys = new float[cTrack.KeyQuat.Length * 4];
            for (int k = 0; k < cTrack.KeyQuat.Length; k++)
            {
                var sw = CoordConvert.SwapQuat(cTrack.KeyQuat[k]);
                quatKeys[k * 4 + 0] = sw[0];
                quatKeys[k * 4 + 1] = sw[1];
                quatKeys[k * 4 + 2] = sw[2];
                quatKeys[k * 4 + 3] = sw[3];
            }

            var scaleKeys = new float[cTrack.KeyScale.Length * 3];
            for (int k = 0; k < cTrack.KeyScale.Length; k++)
            {
                var sw = CoordConvert.SwapScale(cTrack.KeyScale[k]);
                scaleKeys[k * 3 + 0] = sw[0];
                scaleKeys[k * 3 + 1] = sw[1];
                scaleKeys[k * 3 + 2] = sw[2];
            }

            tracks.Add(new AnimBoneTrackDto(boneName, mode, hasExplicit, posKeys, quatKeys, scaleKeys));
        }

        var curves = new List<AnimFloatCurveDto>();
        if (orig.CompressedCurveData?.FloatCurves is { Length: > 0 } floatCurves)
        {
            foreach (var fc in floatCurves)
            {
                var keys = fc.FloatCurve?.Keys;
                if (keys == null || keys.Length == 0) continue;

                var times = new float[keys.Length];
                var values = new float[keys.Length];
                for (int k = 0; k < keys.Length; k++)
                {
                    times[k] = keys[k].Time;
                    values[k] = keys[k].Value;
                }
                curves.Add(new AnimFloatCurveDto(fc.CurveName.Text, times, values));
            }
        }

        var fps = cSeq.NumFrames > 0 && cSeq.AnimEndTime > 0
            ? cSeq.NumFrames / cSeq.AnimEndTime
            : (orig.SequenceLength > 0 && orig.NumFrames > 0 ? orig.NumFrames / orig.SequenceLength : 30f);

        return new AnimSegmentPayloadDto(
            cSeq.Name,
            slotName,
            startTime,
            endTime > 0 ? endTime : orig.SequenceLength,
            playRate,
            loopingCount <= 0 ? 1 : loopingCount,
            orig.SequenceLength > 0 ? orig.SequenceLength : cSeq.AnimEndTime,
            fps,
            cSeq.NumFrames,
            isAdditive,
            hasRefPoseSeq,
            tracks,
            curves);
    }

    private static bool IsLikelySecondaryBone(string boneName) =>
        boneName.Contains("Hair", StringComparison.OrdinalIgnoreCase) ||
        boneName.Contains("Skirt", StringComparison.OrdinalIgnoreCase) ||
        boneName.Contains("Piao", StringComparison.OrdinalIgnoreCase) ||
        boneName.Contains("Rib", StringComparison.OrdinalIgnoreCase) ||
        boneName.Contains("Fadai", StringComparison.OrdinalIgnoreCase) ||
        boneName.Contains("Cloth", StringComparison.OrdinalIgnoreCase) ||
        boneName.Contains("Cape", StringComparison.OrdinalIgnoreCase) ||
        boneName.Contains("Tail", StringComparison.OrdinalIgnoreCase) ||
        boneName.Contains("Dress", StringComparison.OrdinalIgnoreCase) ||
        boneName.Contains("Sleeve", StringComparison.OrdinalIgnoreCase);
}
