using System.Collections.Concurrent;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Objects.MovieScene;
using CUE4Parse.UE4.Objects.UObject;
using WuWaViewer.Server.Models;

namespace WuWaViewer.Server.Services;

public sealed class CutsceneService(GameAssetService assets)
{
    private readonly ConcurrentDictionary<string, CutsceneDetailDto> _cache = new(StringComparer.OrdinalIgnoreCase);

    public CutsceneDetailDto? GetCutsceneDetail(string sequencePath, int depth = 0)
    {
        var norm = assets.NormalizePackagePath(sequencePath);
        if (depth == 0 && _cache.TryGetValue(norm, out var cached))
            return cached;

        if (!assets.TryLoadPackageSafe(norm, out var pkg))
            return null;

        var exports = pkg.ExportsLazy.Select(e => e.Value).ToList();
        var movieScene = exports.FirstOrDefault(e => e.ExportType.Equals("MovieScene", StringComparison.OrdinalIgnoreCase));
        if (movieScene == null)
            return null;

        var tickRes = ReadFrameRate(movieScene, "TickResolution", 24000f);
        var displayRate = ReadFrameRate(movieScene, "DisplayRate", 30f);

        var (startSec, endSec) = ReadFrameRange(movieScene, "PlaybackRange", tickRes);

        var actorsByGuid = new Dictionary<string, ActorAcc>(StringComparer.OrdinalIgnoreCase);

        // 1. Collect ObjectTemplates from Spawnables (gives Actor name, Mesh asset hint, Camera flag)
        var spawnables = movieScene.GetOrDefault<FStructFallback[]>("Spawnables") ?? [];
        foreach (var sp in spawnables)
        {
            var guid = ReadGuid(sp);
            var name = sp.GetOrDefault<string>("Name") ?? guid;
            var objTemplate = sp.GetOrDefault<FPackageIndex>("ObjectTemplate")?.Load<UObject>();
            var acc = GetOrCreateActor(actorsByGuid, guid, name);

            if (objTemplate != null)
            {
                InspectActorTemplate(objTemplate, exports, acc);
            }
        }

        // Also check Possessables
        var possessables = movieScene.GetOrDefault<FStructFallback[]>("Possessables") ?? [];
        foreach (var ps in possessables)
        {
            var guid = ReadGuid(ps);
            var name = ps.GetOrDefault<string>("Name") ?? guid;
            GetOrCreateActor(actorsByGuid, guid, name);
        }

        // 2. Inspect MasterTracks (CameraCutTrack, CinematicShotTrack / SubTrack)
        var cameraCuts = new List<CutsceneCameraCutDto>();
        var masterTracks = movieScene.GetOrDefault<FPackageIndex[]>("MasterTracks") ?? [];
        foreach (var mtIdx in masterTracks)
        {
            var track = mtIdx?.Load<UObject>();
            if (track == null) continue;
            if (track.ExportType.Equals("MovieSceneCameraCutTrack", StringComparison.OrdinalIgnoreCase))
            {
                foreach (var sec in LoadSections(track))
                {
                    var (s0, s1) = ReadFrameRange(sec, "SectionRange", tickRes);
                    var camBinding = sec.GetOrDefault<FStructFallback>("CameraBindingID");
                    var camGuid = camBinding != null ? ReadGuid(camBinding, "Guid") : "";
                    if (!string.IsNullOrEmpty(camGuid))
                        cameraCuts.Add(new CutsceneCameraCutDto(s0 - startSec, s1 - startSec, camGuid));
                }
            }
            else if (track.ExportType.Contains("CinematicShotTrack", StringComparison.OrdinalIgnoreCase) ||
                     track.ExportType.Contains("SubTrack", StringComparison.OrdinalIgnoreCase))
            {
                if (depth < 1)
                {
                    foreach (var sec in LoadSections(track))
                    {
                        var subSeqIdx = sec.GetOrDefault<FPackageIndex>("SubSequence");
                        var subPath = subSeqIdx?.ResolvedObject?.GetPathName();
                        if (string.IsNullOrEmpty(subPath)) continue;

                        var (s0, s1) = ReadFrameRange(sec, "SectionRange", tickRes);
                        var offset = s0 - startSec;
                        var sub = GetCutsceneDetail(subPath, depth + 1);
                        if (sub == null) continue;

                        foreach (var subActor in sub.Actors)
                        {
                            var merged = GetOrCreateActor(actorsByGuid, subActor.Guid, subActor.Name);
                            merged.MeshPath ??= subActor.MeshPath;
                            merged.IsCamera |= subActor.IsCamera;
                            foreach (var a in subActor.AnimSections)
                                merged.AnimSections.Add(a with { StartTime = a.StartTime + offset, EndTime = a.EndTime + offset });
                            foreach (var t in subActor.TransformTracks)
                                merged.TransformTracks.Add(ShiftTransformTrack(t, offset));
                            foreach (var fov in subActor.CameraFovTracks)
                                merged.CameraFovTracks.Add(new CutsceneFloatChannelDto(fov.DefaultValue, fov.Times.Select(x => x + offset).ToArray(), fov.Values));
                        }

                        foreach (var cc in sub.CameraCuts)
                        {
                            var clippedStart = MathF.Max(offset, cc.StartTime + offset);
                            var clippedEnd = s1 > s0 ? MathF.Min(s1 - startSec, cc.EndTime + offset) : cc.EndTime + offset;
                            if (clippedEnd > clippedStart)
                                cameraCuts.Add(new CutsceneCameraCutDto(clippedStart, clippedEnd, cc.CameraGuid));
                        }
                    }
                }
            }
        }

        // 3. ObjectBindings -> Bind tracks (SkeletalAnimation, 3DTransform, Float/FOV)
        var bindings = movieScene.GetOrDefault<FStructFallback[]>("ObjectBindings") ?? [];
        var bindingOwner = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var b in bindings)
        {
            var guid = ReadGuid(b, "ObjectGuid");
            var bName = b.GetOrDefault<string>("BindingName") ?? guid;
            var acc = GetOrCreateActor(actorsByGuid, guid, bName);

            foreach (var trkIdx in b.GetOrDefault<FPackageIndex[]>("Tracks") ?? [])
            {
                var track = trkIdx?.Load<UObject>();
                if (track == null) continue;
                ParseBindingTrack(track, acc, startSec, tickRes);
            }
        }

        // Try to match sub-bindings like CineCameraComponent / Mesh parented under Spawnables (matching possessable ParentGuid or component name)
        foreach (var ps in possessables)
        {
            var guid = ReadGuid(ps);
            var parentGuid = ReadGuid(ps, "ParentGuid");
            if (!string.IsNullOrEmpty(parentGuid) && actorsByGuid.TryGetValue(parentGuid, out var parentAcc) &&
                actorsByGuid.TryGetValue(guid, out var childAcc))
            {
                if (childAcc.CameraFovTracks.Count > 0)
                {
                    parentAcc.IsCamera = true;
                    parentAcc.CameraFovTracks.AddRange(childAcc.CameraFovTracks);
                }
                if (childAcc.AnimSections.Count > 0)
                    parentAcc.AnimSections.AddRange(childAcc.AnimSections);
                if (childAcc.TransformTracks.Count > 0 && parentAcc.TransformTracks.Count == 0)
                    parentAcc.TransformTracks.AddRange(childAcc.TransformTracks);
                actorsByGuid.Remove(guid);
            }
        }

        // Final actor matching hints against playable Role meshes
        var finalActors = actorsByGuid.Values
            .Where(a => a.AnimSections.Count > 0 || a.IsCamera || a.MeshPath != null || a.TransformTracks.Count > 0)
            .Select(a =>
            {
                var (charHint, varHint) = MatchCharacterHint(a.MeshPath, a.Name, a.AnimSections);
                return new CutsceneActorDto(
                    a.Guid,
                    a.Name,
                    a.MeshPath,
                    charHint,
                    varHint,
                    a.IsCamera,
                    a.AnimSections.OrderBy(s => s.StartTime).ToList(),
                    a.TransformTracks,
                    a.CameraFovTracks);
            })
            .ToList();

        float duration = MathF.Max(0.1f, endSec - startSec);
        if (finalActors.Count > 0)
        {
            var maxSectionEnd = finalActors.SelectMany(a => a.AnimSections).Select(s => s.EndTime).DefaultIfEmpty(duration).Max();
            duration = MathF.Max(duration, maxSectionEnd);
        }

        var detail = new CutsceneDetailDto(
            norm,
            Path.GetFileName(norm),
            duration,
            displayRate,
            tickRes,
            finalActors,
            cameraCuts.OrderBy(c => c.StartTime).ToList());

        if (depth == 0) _cache[norm] = detail;
        return detail;
    }

    private void InspectActorTemplate(UObject objTemplate, List<UObject> pkgExports, ActorAcc acc)
    {
        if (objTemplate.ExportType.Contains("Camera", StringComparison.OrdinalIgnoreCase))
            acc.IsCamera = true;

        // Look for Mesh / SkeletalMesh / SkeletalMeshComponent reference directly or in children exports
        void ScanComponent(UObject comp)
        {
            if (comp.ExportType.Contains("Camera", StringComparison.OrdinalIgnoreCase))
                acc.IsCamera = true;

            var sk = comp.GetOrDefault<FPackageIndex>("SkeletalMesh") ?? comp.GetOrDefault<FPackageIndex>("StaticMesh");
            var path = sk?.ResolvedObject?.GetPathName();
            if (!string.IsNullOrEmpty(path))
                acc.MeshPath = assets.NormalizePackagePath(path);
        }

        ScanComponent(objTemplate);

        foreach (var prop in objTemplate.Properties)
        {
            if (prop.Tag?.GenericValue is FPackageIndex idx && idx.TryLoad<UObject>(out var child))
                ScanComponent(child);
        }

        if (acc.MeshPath == null)
        {
            foreach (var exp in pkgExports)
            {
                if (exp.Outer?.Name == objTemplate.Name && exp.ExportType.Contains("SkeletalMeshComponent", StringComparison.OrdinalIgnoreCase))
                    ScanComponent(exp);
            }
        }
    }

    private void ParseBindingTrack(UObject track, ActorAcc acc, float baseStartSec, float tickRes)
    {
        if (track.ExportType.Equals("MovieSceneSkeletalAnimationTrack", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var sec in LoadSections(track))
            {
                var (s0, s1) = ReadFrameRange(sec, "SectionRange", tickRes);
                var prms = sec.GetOrDefault<FStructFallback>("Params");
                if (prms == null) continue;
                var animIdx = prms.GetOrDefault<FPackageIndex>("Animation");
                var animPath = animIdx?.ResolvedObject?.GetPathName();
                if (string.IsNullOrEmpty(animPath)) continue;

                var normAnim = assets.NormalizePackagePath(animPath);
                var playRate = prms.GetOrDefault("PlayRate", 1f);
                var bLoop = prms.GetOrDefault("bAnimLoop", false);
                var firstOffset = ReadFrameNumber(prms, "FirstLoopStartFrameOffset") / tickRes;
                var startOffset = ReadFrameNumber(prms, "StartFrameOffset") / tickRes;

                acc.AnimSections.Add(new CutsceneAnimSectionDto(
                    MathF.Max(0f, s0 - baseStartSec),
                    MathF.Max(0f, s1 - baseStartSec),
                    normAnim,
                    Path.GetFileName(normAnim),
                    playRate == 0 ? 1f : playRate,
                    bLoop,
                    firstOffset,
                    startOffset));
            }
        }
        else if (track.ExportType.Equals("MovieScene3DTransformTrack", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var sec in LoadSections(track))
            {
                var (s0, s1) = ReadFrameRange(sec, "SectionRange", tickRes);
                var tArr = GetChannels(sec, "Translation", 3);
                var rArr = GetChannels(sec, "Rotation", 3);
                var sArr = GetChannels(sec, "Scale", 3);

                acc.TransformTracks.Add(new CutsceneTransformTrackDto(
                    s0 - baseStartSec,
                    s1 - baseStartSec,
                    ConvertFloatChannel(tArr[0], baseStartSec, tickRes, CoordConvert.UnitScale),
                    ConvertFloatChannel(tArr[1], baseStartSec, tickRes, CoordConvert.UnitScale),
                    ConvertFloatChannel(tArr[2], baseStartSec, tickRes, CoordConvert.UnitScale),
                    ConvertFloatChannel(rArr[0], baseStartSec, tickRes, 1f),
                    ConvertFloatChannel(rArr[1], baseStartSec, tickRes, 1f),
                    ConvertFloatChannel(rArr[2], baseStartSec, tickRes, 1f),
                    ConvertFloatChannel(sArr[0], baseStartSec, tickRes, 1f, 1f),
                    ConvertFloatChannel(sArr[1], baseStartSec, tickRes, 1f, 1f),
                    ConvertFloatChannel(sArr[2], baseStartSec, tickRes, 1f, 1f)));
            }
        }
        else if (track.ExportType.Contains("FloatTrack", StringComparison.OrdinalIgnoreCase))
        {
            var trackName = track.GetOrDefault<FName>("PropertyName").Text;
            var isFocal = trackName.Contains("FocalLength", StringComparison.OrdinalIgnoreCase);
            if (isFocal || trackName.Contains("FieldOfView", StringComparison.OrdinalIgnoreCase))
            {
                foreach (var sec in LoadSections(track))
                {
                    var chObj = UnwrapPropertyChannel(sec, "FloatCurve") ?? UnwrapPropertyChannel(sec, "Channel");
                    if (chObj != null)
                    {
                        var dto = ConvertFloatChannel(chObj, baseStartSec, tickRes, 1f, isFocal ? 35f : 45f);
                        if (isFocal)
                        {
                            // Convert FocalLength (mm, 36mm full-frame 16:9 sensor height = 20.25mm) -> vertical FOV deg
                            static float FocalToFovDeg(float mm) =>
                                mm > 1f ? 2f * MathF.Atan(10.125f / mm) * (180f / MathF.PI) : 38f;
                            dto = new CutsceneFloatChannelDto(
                                FocalToFovDeg(dto.DefaultValue),
                                dto.Times,
                                dto.Values.Select(FocalToFovDeg).ToArray());
                        }
                        acc.CameraFovTracks.Add(dto);
                    }
                }
            }
        }
    }

    private (string? CharId, string? VarId) MatchCharacterHint(string? meshPath, string actorName, List<CutsceneAnimSectionDto> anims)
    {
        if (!string.IsNullOrEmpty(meshPath))
        {
            var found = assets.Characters.FirstOrDefault(c =>
                c.Variants.Any(v => v.PrimaryMeshPath.Equals(meshPath, StringComparison.OrdinalIgnoreCase) ||
                                    v.ExtraParts.Any(p => p.MeshPath.Equals(meshPath, StringComparison.OrdinalIgnoreCase))));
            if (found != null)
            {
                var v = found.Variants.FirstOrDefault(v =>
                    v.PrimaryMeshPath.Equals(meshPath, StringComparison.OrdinalIgnoreCase) ||
                    v.ExtraParts.Any(p => p.MeshPath.Equals(meshPath, StringComparison.OrdinalIgnoreCase)));
                return (found.Id, v?.Id);
            }
        }

        // Heuristic match from actor name or anim names
        var searchHaystack = actorName + " " + string.Join(" ", anims.Select(a => a.AnimPath));
        foreach (var ch in assets.Characters)
        {
            if (searchHaystack.Contains(ch.Name, StringComparison.OrdinalIgnoreCase))
                return (ch.Id, ch.Variants.FirstOrDefault()?.Id);
        }

        return (null, null);
    }

    private static List<UObject> LoadSections(UObject track)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<UObject>();
        foreach (var propName in new[] { "Sections", "AnimationSections", "SubSections" })
        {
            var arr = track.GetOrDefault<FPackageIndex[]>(propName) ?? [];
            foreach (var p in arr)
            {
                if (p?.TryLoad<UObject>(out var s) == true && seen.Add(s.GetPathName()))
                    list.Add(s);
            }
        }
        return list;
    }

    private static object? UnwrapGenericChannel(object? genericVal) => genericVal switch
    {
        FMovieSceneChannel<float> fc => fc,
        FMovieSceneChannel<double> dc => dc,
        FStructFallback sf => sf,
        FScriptStruct ss => ss.StructType,
        _ => null
    };

    private static object? UnwrapPropertyChannel(IPropertyHolder holder, string propName)
    {
        foreach (var prop in holder.Properties)
        {
            if (prop.Name.Text.Equals(propName, StringComparison.OrdinalIgnoreCase))
                return UnwrapGenericChannel(prop.Tag?.GenericValue);
        }
        return null;
    }

    private static object?[] GetChannels(UObject sec, string baseName, int count)
    {
        var arr = new object?[count];
        foreach (var prop in sec.Properties)
        {
            if (prop.Name.Text.Equals(baseName, StringComparison.OrdinalIgnoreCase) &&
                prop.ArrayIndex >= 0 && prop.ArrayIndex < count)
            {
                arr[prop.ArrayIndex] = UnwrapGenericChannel(prop.Tag?.GenericValue);
            }
        }
        return arr;
    }

    private static CutsceneFloatChannelDto ConvertFloatChannel(object? chObj, float baseStartSec, float parentTickRes, float scale, float fallbackDefault = 0f)
    {
        if (chObj is FMovieSceneChannel<float> fChan)
        {
            float tickRes = fChan.TickResolution.Numerator > 0
                ? (float)fChan.TickResolution.Numerator / (fChan.TickResolution.Denominator > 0 ? fChan.TickResolution.Denominator : 1)
                : parentTickRes;
            float defVal = (fChan.bHasDefaultValue ? fChan.DefaultValue : fallbackDefault) * scale;
            if (fChan.Times is { Length: > 0 } && fChan.Values is { Length: > 0 })
            {
                int n = Math.Min(fChan.Times.Length, fChan.Values.Length);
                var times = new float[n];
                var values = new float[n];
                for (int i = 0; i < n; i++)
                {
                    times[i] = fChan.Times[i].Value / tickRes - baseStartSec;
                    values[i] = fChan.Values[i].Value * scale;
                }
                return new CutsceneFloatChannelDto(defVal, times, values);
            }
            return new CutsceneFloatChannelDto(defVal, [], []);
        }

        if (chObj is FMovieSceneChannel<double> dChan)
        {
            float tickRes = dChan.TickResolution.Numerator > 0
                ? (float)dChan.TickResolution.Numerator / (dChan.TickResolution.Denominator > 0 ? dChan.TickResolution.Denominator : 1)
                : parentTickRes;
            float defVal = (dChan.bHasDefaultValue ? (float)dChan.DefaultValue : fallbackDefault) * scale;
            if (dChan.Times is { Length: > 0 } && dChan.Values is { Length: > 0 })
            {
                int n = Math.Min(dChan.Times.Length, dChan.Values.Length);
                var times = new float[n];
                var values = new float[n];
                for (int i = 0; i < n; i++)
                {
                    times[i] = dChan.Times[i].Value / tickRes - baseStartSec;
                    values[i] = (float)dChan.Values[i].Value * scale;
                }
                return new CutsceneFloatChannelDto(defVal, times, values);
            }
            return new CutsceneFloatChannelDto(defVal, [], []);
        }

        if (chObj is not FStructFallback ch)
            return new CutsceneFloatChannelDto(fallbackDefault * scale, [], []);

        var fbTickRes = ReadFrameRate(ch, "TickResolution", parentTickRes);
        var fbDefVal = ch.GetOrDefault("DefaultValue", fallbackDefault) * scale;

        var timesFrames = ch.GetOrDefault<FFrameNumber[]>("Times") ?? [];
        var valsFloats = ch.GetOrDefault<FMovieSceneValue<float>[]>("Values");

        if (valsFloats is { Length: > 0 } && timesFrames.Length > 0)
        {
            int n = Math.Min(timesFrames.Length, valsFloats.Length);
            var times = new float[n];
            var values = new float[n];
            for (int i = 0; i < n; i++)
            {
                times[i] = timesFrames[i].Value / fbTickRes - baseStartSec;
                values[i] = valsFloats[i].Value * scale;
            }
            return new CutsceneFloatChannelDto(fbDefVal, times, values);
        }

        var valsDoubles = ch.GetOrDefault<FMovieSceneValue<double>[]>("Values");
        if (valsDoubles is { Length: > 0 } && timesFrames.Length > 0)
        {
            int n = Math.Min(timesFrames.Length, valsDoubles.Length);
            var times = new float[n];
            var values = new float[n];
            for (int i = 0; i < n; i++)
            {
                times[i] = timesFrames[i].Value / fbTickRes - baseStartSec;
                values[i] = (float)valsDoubles[i].Value * scale;
            }
            return new CutsceneFloatChannelDto(fbDefVal, times, values);
        }

        return new CutsceneFloatChannelDto(fbDefVal, [], []);
    }

    private static CutsceneTransformTrackDto ShiftTransformTrack(CutsceneTransformTrackDto t, float offset)
    {
        CutsceneFloatChannelDto Shift(CutsceneFloatChannelDto c) =>
            new(c.DefaultValue, c.Times.Select(x => x + offset).ToArray(), c.Values);
        return new(t.StartTime + offset, t.EndTime + offset,
            Shift(t.Tx), Shift(t.Ty), Shift(t.Tz),
            Shift(t.Rx), Shift(t.Ry), Shift(t.Rz),
            Shift(t.Sx), Shift(t.Sy), Shift(t.Sz));
    }

    private static float ReadFrameRate(IPropertyHolder holder, string prop, float fallback)
    {
        var fr = holder.GetOrDefault<FFrameRate>(prop);
        if (fr.Numerator > 0)
            return (float)fr.Numerator / (fr.Denominator > 0 ? fr.Denominator : 1);
        var sf = holder.GetOrDefault<FStructFallback>(prop);
        if (sf != null)
        {
            var num = sf.GetOrDefault("Numerator", 0);
            var den = sf.GetOrDefault("Denominator", 1);
            if (num > 0) return (float)num / (den > 0 ? den : 1);
        }
        return fallback;
    }

    private static int ReadFrameNumber(IPropertyHolder holder, string prop)
    {
        var fn = holder.GetOrDefault<FFrameNumber>(prop);
        if (fn.Value != 0) return fn.Value;
        var sf = holder.GetOrDefault<FStructFallback>(prop);
        if (sf != null)
        {
            var inner = sf.GetOrDefault<FFrameNumber>("FrameNumber");
            if (inner.Value != 0) return inner.Value;
            return sf.GetOrDefault("Value", 0);
        }
        return 0;
    }

    private static (float Start, float End) ReadFrameRange(IPropertyHolder holder, string prop, float tickRes)
    {
        var mr = holder.GetOrDefault<FMovieSceneFrameRange>(prop);
        if (mr.Value.LowerBound.Value.Value != 0 || mr.Value.UpperBound.Value.Value != 0)
            return (mr.Value.LowerBound.Value.Value / tickRes, mr.Value.UpperBound.Value.Value / tickRes);

        var tr = holder.GetOrDefault<FStructFallback>(prop);
        if (tr == null) return (0f, 0f);
        var inner = tr.GetOrDefault<FStructFallback>("Value") ?? tr;
        var s = (inner.GetOrDefault<FStructFallback>("LowerBound")?.GetOrDefault<FFrameNumber>("Value").Value ?? 0) / tickRes;
        var e = (inner.GetOrDefault<FStructFallback>("UpperBound")?.GetOrDefault<FFrameNumber>("Value").Value ?? 0) / tickRes;
        return (s, e);
    }

    private static string ReadGuid(FStructFallback f, string prop = "Guid")
    {
        var g = f.GetOrDefault<FGuid>(prop);
        return g.ToString();
    }

    private static ActorAcc GetOrCreateActor(Dictionary<string, ActorAcc> map, string guid, string name)
    {
        if (!map.TryGetValue(guid, out var acc))
        {
            acc = new ActorAcc(guid, name);
            map[guid] = acc;
        }
        else if (string.IsNullOrEmpty(acc.Name) && !string.IsNullOrEmpty(name))
        {
            acc.Name = name;
        }
        return acc;
    }

    private sealed class ActorAcc(string guid, string name)
    {
        public string Guid { get; } = guid;
        public string Name { get; set; } = name;
        public string? MeshPath { get; set; }
        public bool IsCamera { get; set; }
        public List<CutsceneAnimSectionDto> AnimSections { get; } = [];
        public List<CutsceneTransformTrackDto> TransformTracks { get; } = [];
        public List<CutsceneFloatChannelDto> CameraFovTracks { get; } = [];
    }
}
