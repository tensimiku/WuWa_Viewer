using System.Collections.Concurrent;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Assets.Exports.Material;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse_Conversion.Dto;
using CUE4Parse_Conversion.Formats.Meshes;
using CUE4Parse_Conversion.Options;
using CUE4Parse_Conversion.Textures;
using Newtonsoft.Json;
using WuWaViewer.Server.Models;
using MeshSectionDto = WuWaViewer.Server.Models.MeshSectionDto;

namespace WuWaViewer.Server.Services;

public sealed class ModelService(GameAssetService assets, ILogger<ModelService> logger)
{
    private readonly ConcurrentDictionary<string, ModelManifestDto> _manifestCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _modelLocks = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _texLocks = new(StringComparer.OrdinalIgnoreCase);
    private HashSet<string>? _uassetSet;
    private bool AssetExists(string normPath) =>
        (_uassetSet ??= new HashSet<string>(assets.AllUAssets, StringComparer.OrdinalIgnoreCase)).Contains(normPath + ".uasset");

    /// <summary>
    /// Attaches per-character /Wet/*_Darken, *_Reflect and /BlendWater/*_BlendWater metadata when present in VFS.
    /// </summary>
    private void AttachWetOverlayMetadata(
        string slotName,
        string assetPath,
        Dictionary<string, float> scalars,
        Dictionary<string, bool> switches)
    {
        if (string.IsNullOrEmpty(assetPath) ||
            slotName.EndsWith("_OL", StringComparison.OrdinalIgnoreCase) ||
            slotName.EndsWith("_HETA", StringComparison.OrdinalIgnoreCase) ||
            slotName.EndsWith("_FS", StringComparison.OrdinalIgnoreCase))
            return;

        var norm = assets.NormalizePackagePath(assetPath).Replace('\\', '/');
        var lastSlash = norm.LastIndexOf('/');
        if (lastSlash <= 0) return;
        var dir = norm[..lastSlash];
        var miFile = norm[(lastSlash + 1)..];
        var modelDir = dir.EndsWith("/Seq", StringComparison.OrdinalIgnoreCase) ? dir[..^"/Seq".Length] : dir;

        var blendWaterPath = $"{modelDir}/BlendWater/{miFile}_BlendWater";
        if (AssetExists(blendWaterPath))
            switches["HasBlendWaterMI"] = true;

        var wetCandidates = new[]
        {
            $"{modelDir}/Wet/{miFile}_Darken",
            $"{modelDir}/Wet/{miFile}_Reflect"
        };
        foreach (var wetPath in wetCandidates)
        {
            if (!AssetExists(wetPath)) continue;
            switches["HasWetOverlayMI"] = true;
            if (!assets.TryLoadPackageSafe(wetPath, out var wetPkg)) continue;
            var wetMi = wetPkg.ExportsLazy.Select(e => e.Value).OfType<UMaterialInstance>().FirstOrDefault();
            if (wetMi == null) continue;
            if (wetMi.StaticParameters != null)
            {
                foreach (var sw in wetMi.StaticParameters.StaticSwitchParameters)
                {
                    if (sw.Name.Contains("Wet", StringComparison.OrdinalIgnoreCase) ||
                        sw.Name.Contains("TypeMask", StringComparison.OrdinalIgnoreCase))
                        switches[$"WetMI_{sw.Name}"] = sw.Value;
                }
            }
            if (wetMi is UMaterialInstanceConstant wetMic)
            {
                foreach (var sc in wetMic.ScalarParameterValues)
                {
                    var key = sc.ParameterInfo.Name.Text;
                    if (!scalars.ContainsKey($"WetMI_{key}"))
                        scalars[$"WetMI_{key}"] = sc.ParameterValue;
                }
            }
        }
    }

    private static async Task WriteBytesAtomicAsync(string targetPath, byte[] bytes)
    {
        var dir = Path.GetDirectoryName(targetPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var tmpPath = $"{targetPath}.{Guid.NewGuid():N}.tmp";
        await File.WriteAllBytesAsync(tmpPath, bytes);
        File.Move(tmpPath, targetPath, overwrite: true);
    }

    private static async Task WriteTextAtomicAsync(string targetPath, string text)
    {
        var dir = Path.GetDirectoryName(targetPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var tmpPath = $"{targetPath}.{Guid.NewGuid():N}.tmp";
        await File.WriteAllTextAsync(tmpPath, text);
        File.Move(tmpPath, targetPath, overwrite: true);
    }

    private static readonly ExportOptions MeshExportOpts = new(
        meshFormat: EMeshFormat.Gltf2,
        meshQuality: EMeshQuality.Highest,
        exportMaterials: false,
        exportMorphTargets: true,
        includeDisabledMeshSections: false);

    private static readonly ExportOptions TexExportOpts = new(
        textureFormat: ETextureFormat.Png,
        textureQuality: 100);

    public async Task<ModelManifestDto?> GetModelManifestAsync(string meshPath)
    {
        var norm = assets.NormalizePackagePath(meshPath);
        if (_manifestCache.TryGetValue(norm, out var cached))
            return cached;

        var gate = _modelLocks.GetOrAdd(norm, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync();
        try
        {
            if (_manifestCache.TryGetValue(norm, out cached))
                return cached;

            var manifestJsonPath = assets.GetCacheFilePath("manifest", norm, "json");
            var glbPath = assets.GetCacheFilePath("glb", norm, "glb");

            if (File.Exists(manifestJsonPath) && File.Exists(glbPath))
            {
                var fromDisk = JsonConvert.DeserializeObject<ModelManifestDto>(await File.ReadAllTextAsync(manifestJsonPath));
                if (fromDisk != null)
                {
                    _manifestCache[norm] = fromDisk;
                    return fromDisk;
                }
            }

            var obj = assets.LoadObjectSafe<UObject>(norm);
            if (obj == null) return null;

            ModelManifestDto manifest;
            byte[] glbBytes;

            if (obj is USkeletalMesh skMesh)
            {
                (manifest, glbBytes) = BuildSkeletalMeshManifestAndGlb(norm, skMesh);
            }
            else if (obj is UStaticMesh stMesh)
            {
                (manifest, glbBytes) = BuildStaticMeshManifestAndGlb(norm, stMesh);
            }
            else
            {
                return null;
            }

            await WriteBytesAtomicAsync(glbPath, glbBytes);
            await WriteTextAtomicAsync(manifestJsonPath, JsonConvert.SerializeObject(manifest));
            _manifestCache[norm] = manifest;
            logger.LogInformation("Built model {Mesh}: GLB={Size:N0} bytes, Mats={Mats}, Morphs={Morphs}",
                norm, glbBytes.Length, manifest.Materials.Count, manifest.MorphTargets.Count);
            return manifest;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<byte[]?> GetGlbBytesAsync(string meshPath)
    {
        var norm = assets.NormalizePackagePath(meshPath);
        var glbPath = assets.GetCacheFilePath("glb", norm, "glb");
        if (!File.Exists(glbPath))
            await GetModelManifestAsync(norm);
        return File.Exists(glbPath) ? await File.ReadAllBytesAsync(glbPath) : null;
    }

    public async Task<byte[]?> GetTexturePngAsync(string texturePath)
    {
        var norm = assets.NormalizePackagePath(texturePath);
        var cachePath = assets.GetCacheFilePath("tex", norm, "png");
        if (File.Exists(cachePath))
            return await File.ReadAllBytesAsync(cachePath);

        var gate = _texLocks.GetOrAdd(norm, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync();
        try
        {
            if (File.Exists(cachePath))
                return await File.ReadAllBytesAsync(cachePath);

            var tex = assets.LoadObjectSafe<UTexture>(norm);
            if (tex == null) return null;

            CTexture? decoded = tex switch
            {
                UTextureCube cube => cube.DecodeMip(cube.GetFirstMipIndex(), TexExportOpts)?.ToPanorama(),
                UTexture2DArray arr => arr.DecodeTextureArray(arr.GetFirstMipIndex(), TexExportOpts)?.FirstOrDefault(),
                _ => tex.Decode(TexExportOpts)
            };

            if (decoded == null) return null;
            var bytes = decoded.Encode(TexExportOpts, out _);
            if (bytes.Length == 0) return null;

            await WriteBytesAtomicAsync(cachePath, bytes);
            return bytes;
        }
        finally
        {
            gate.Release();
        }
    }

    public List<CharacterPartDto> ResolveBlueprintParts(string characterId, string variantId)
    {
        var prefix = $"Client/Content/Aki/Character/Role/{characterId}/";
        var siblingPrefix = $"Client/Content/Aki/Character/Role/{characterId}_";
        var slashIdx = characterId.IndexOf('/');
        var bodyType = slashIdx > 0 ? characterId[..slashIdx] : "";
        var charName = slashIdx > 0 ? characterId[(slashIdx + 1)..] : characterId;
        var isRover = charName.Equals("Nvzhu", StringComparison.OrdinalIgnoreCase)
                   || charName.Equals("Nanzhu", StringComparison.OrdinalIgnoreCase);
        var roverElemPrefixes = isRover
            ? new[] { "Dark", "Thunder", "Wind", "Light", "Ice", "Fire" }.Select(e => $"{e}{charName}").ToArray()
            : [];

        var roleFiles = assets.AllUAssets
            .Where(f =>
            {
                if (f.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
                    f.StartsWith(siblingPrefix, StringComparison.OrdinalIgnoreCase))
                    return true;
                if (isRover)
                {
                    var fn = Path.GetFileNameWithoutExtension(f);
                    if (fn.StartsWith("BP_", StringComparison.OrdinalIgnoreCase))
                    {
                        return fn.Equals($"BP_{charName}", StringComparison.OrdinalIgnoreCase) ||
                               fn.StartsWith($"BP_{charName}_", StringComparison.OrdinalIgnoreCase) ||
                               roverElemPrefixes.Any(ep =>
                                   fn.Equals($"BP_{ep}", StringComparison.OrdinalIgnoreCase) ||
                                   fn.StartsWith($"BP_{ep}_", StringComparison.OrdinalIgnoreCase));
                    }
                    return roverElemPrefixes.Any(ep => f.Contains($"/{ep}/", StringComparison.OrdinalIgnoreCase));
                }
                return false;
            })
            .ToList();

        var bpFiles = roleFiles
            .Where(f => Path.GetFileNameWithoutExtension(f).StartsWith("BP_", StringComparison.OrdinalIgnoreCase))
            .ToList();

        // Detect skin suffix token on variantId (e.g. Md20011, Md30011, Lifu, wumao)
        var skinTokens = new[] { "Md20011", "Md30011", "Md40011", "20011", "30011", "Lifu", "wumao" };
        var activeSkinToken = skinTokens.FirstOrDefault(t => variantId.Contains(t, StringComparison.OrdinalIgnoreCase));

        bool MatchesVariant(string filePath)
        {
            var fn = Path.GetFileNameWithoutExtension(filePath);
            if (fn.Contains("_Low", StringComparison.OrdinalIgnoreCase) ||
                fn.Contains("_Simple", StringComparison.OrdinalIgnoreCase) ||
                fn.Contains("_Story", StringComparison.OrdinalIgnoreCase) ||
                fn.EndsWith("_FP", StringComparison.OrdinalIgnoreCase) ||
                fn.Contains("_PiaoRouge", StringComparison.OrdinalIgnoreCase))
                return false;

            // Never pull BP_Base_* directly as top-level BP; parents are walked via SuperStruct
            if (fn.StartsWith("BP_Base_", StringComparison.OrdinalIgnoreCase))
                return false;

            if (activeSkinToken != null)
            {
                // For skin variant, prefer skin-matching BPs plus non-skin Seq_Link fallback
                bool isOtherSkin = skinTokens.Any(t => !t.Equals(activeSkinToken, StringComparison.OrdinalIgnoreCase)
                                                    && fn.Contains(t, StringComparison.OrdinalIgnoreCase));
                return !isOtherSkin;
            }
            else
            {
                // Base variant: skip other-skin BPs
                return !skinTokens.Any(t => fn.Contains(t, StringComparison.OrdinalIgnoreCase));
            }
        }

        // Order BPs cleanly: skin-specific first, then Seq_Link / Seq_V2, then primary combat BPs (including element BPs for Rover)
        var candidateBps = bpFiles
            .Where(MatchesVariant)
            .OrderByDescending(f => activeSkinToken != null && Path.GetFileNameWithoutExtension(f).Contains(activeSkinToken, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(f => Path.GetFileNameWithoutExtension(f).Contains(variantId, StringComparison.OrdinalIgnoreCase))
            .ThenBy(f => f.Contains("_Seq", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
            .ThenBy(f => Path.GetFileNameWithoutExtension(f).Length)
            .ToList();

        var result = new List<CharacterPartDto>();
        var seenMeshes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var bpPath in candidateBps)
        {
            var bpName = Path.GetFileNameWithoutExtension(bpPath);
            bool isSeqBp = bpName.Contains("Seq_Link", StringComparison.OrdinalIgnoreCase)
                        || bpName.EndsWith("_Seq_V2", StringComparison.OrdinalIgnoreCase);
            bool isAltFormSeqBp = bpName.Contains("Dark_Seq", StringComparison.OrdinalIgnoreCase);
            bool isElementRoverBp = bpName.StartsWith("BP_Dark", StringComparison.OrdinalIgnoreCase)
                                 || bpName.StartsWith("BP_Thunder", StringComparison.OrdinalIgnoreCase)
                                 || bpName.StartsWith("BP_Wind", StringComparison.OrdinalIgnoreCase);

            // Walk SuperStruct chain from root ancestor -> child
            var chain = new List<CUE4Parse.UE4.Assets.IPackage>();
            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string? curPath = bpPath[..^7];
            int depth = 0;
            while (!string.IsNullOrEmpty(curPath) && depth++ < 6 && visited.Add(curPath))
            {
                if (!assets.TryLoadPackageSafe(curPath, out var curPkg)) break;
                chain.Add(curPkg);

                var bgc = curPkg.ExportsLazy.Select(e => e.Value).OfType<CUE4Parse.UE4.Objects.UObject.UClass>().FirstOrDefault();
                var superRaw = bgc?.SuperStruct?.ResolvedObject?.GetPathName();
                if (string.IsNullOrEmpty(superRaw) || superRaw.StartsWith("/Script/", StringComparison.OrdinalIgnoreCase))
                    break;

                var superPkgPath = superRaw.Contains('.') ? superRaw.Split('.')[0] : superRaw;
                curPath = assets.NormalizePackagePath(superPkgPath);
            }

            if (chain.Count == 0) continue;
            chain.Reverse(); // Ancestor first, leaf BP last

            var compMap = new Dictionary<string, MutableBpComp>(StringComparer.OrdinalIgnoreCase);
            var templateToVarName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            foreach (var pkg in chain)
            {
                foreach (var expLazy in pkg.ExportsLazy)
                {
                    if (expLazy.Value is not UObject uobj) continue;

                    if (uobj.ExportType.Contains("SCS_Node", StringComparison.OrdinalIgnoreCase))
                    {
                        var varName = uobj.GetOrDefault<FName>("InternalVariableName").Text;
                        if (string.IsNullOrEmpty(varName) || varName.Equals("None", StringComparison.OrdinalIgnoreCase))
                            continue;

                        var attachTo = uobj.GetOrDefault<FName>("AttachToName").Text;
                        var parentComp = uobj.GetOrDefault<FName>("ParentComponentOrVariableName").Text;
                        var tplName = uobj.GetOrDefault<FPackageIndex>("ComponentTemplate")?.Name;
                        if (!string.IsNullOrEmpty(tplName))
                            templateToVarName[tplName] = varName;

                        if (!compMap.TryGetValue(varName, out var mc))
                            compMap[varName] = mc = new MutableBpComp { Name = varName };

                        if (!string.IsNullOrEmpty(attachTo) && !attachTo.Equals("None", StringComparison.OrdinalIgnoreCase))
                            mc.AttachSocket = attachTo;
                        if (!string.IsNullOrEmpty(parentComp) && !parentComp.Equals("None", StringComparison.OrdinalIgnoreCase))
                            mc.AttachParent = parentComp;
                    }
                    else if (uobj.ExportType.Contains("SkeletalMeshComponent", StringComparison.OrdinalIgnoreCase) ||
                             uobj.ExportType.Contains("StaticMeshComponent", StringComparison.OrdinalIgnoreCase))
                    {
                        var rawName = uobj.Name;
                        if (rawName.StartsWith("Default__", StringComparison.OrdinalIgnoreCase))
                            continue;

                        var cleanName = rawName.Replace("_GEN_VARIABLE", "", StringComparison.OrdinalIgnoreCase);
                        if (templateToVarName.TryGetValue(rawName, out var mappedName))
                            cleanName = mappedName;
                        // Handle InheritableComponentHandler prefix variants
                        if (cleanName.EndsWith("_GEN_VARIABLE", StringComparison.OrdinalIgnoreCase))
                            cleanName = cleanName[..^"_GEN_VARIABLE".Length];

                        if (!compMap.TryGetValue(cleanName, out var mc))
                            compMap[cleanName] = mc = new MutableBpComp { Name = cleanName };

                        var meshPkg = uobj.GetOrDefault<FPackageIndex>("SkeletalMesh") ?? uobj.GetOrDefault<FPackageIndex>("StaticMesh");
                        var meshPath = meshPkg?.ResolvedObject?.GetPathName();
                        if (!string.IsNullOrEmpty(meshPath))
                            mc.MeshPath = assets.NormalizePackagePath(meshPath);

                        var attachParent = uobj.GetOrDefault<FPackageIndex>("AttachParent")?.Name;
                        if (!string.IsNullOrEmpty(attachParent) && !attachParent.Equals("None", StringComparison.OrdinalIgnoreCase))
                            mc.AttachParent ??= attachParent;

                        var attachSocket = uobj.GetOrDefault<FName>("AttachSocketName").Text;
                        if (!string.IsNullOrEmpty(attachSocket) && !attachSocket.Equals("None", StringComparison.OrdinalIgnoreCase))
                            mc.AttachSocket = attachSocket;

                        if (uobj.Properties.Any(p => p.Name.Text.Equals("RelativeLocation", StringComparison.OrdinalIgnoreCase)))
                            mc.RelPos = CoordConvert.SwapPos(uobj.GetOrDefault<FVector>("RelativeLocation"));
                        if (uobj.Properties.Any(p => p.Name.Text.Equals("RelativeRotation", StringComparison.OrdinalIgnoreCase)))
                            mc.RelQuat = CoordConvert.SwapRotatorToQuat(uobj.GetOrDefault<FRotator>("RelativeRotation"));
                        if (uobj.Properties.Any(p => p.Name.Text.Equals("RelativeScale3D", StringComparison.OrdinalIgnoreCase)))
                            mc.RelScale = CoordConvert.SwapScale(uobj.GetOrDefault("RelativeScale3D", FVector.OneVector));

                        if (uobj.Properties.Any(p => p.Name.Text.Equals("bVisible", StringComparison.OrdinalIgnoreCase)))
                            mc.Visible = uobj.GetOrDefault("bVisible", true);
                        if (uobj.Properties.Any(p => p.Name.Text.Equals("bHiddenInGame", StringComparison.OrdinalIgnoreCase)))
                            mc.HiddenInGame = uobj.GetOrDefault("bHiddenInGame", false);

                        var ovArr = uobj.GetOrDefault<FPackageIndex[]>("OverrideMaterials");
                        if (ovArr != null && ovArr.Length > 0)
                        {
                            mc.OverrideMaterials ??= new Dictionary<int, MaterialSlotDto>();
                            for (int miIdx = 0; miIdx < ovArr.Length; miIdx++)
                            {
                                var matRef = ovArr[miIdx];
                                if (matRef == null || matRef.IsNull) continue;
                                var matObj = matRef.Load<UMaterialInterface>();
                                if (matObj == null) continue;
                                var mp = matRef.ResolvedObject?.GetPathName() ?? "";
                                mc.OverrideMaterials[miIdx] = ExtractMaterialSlot(miIdx, matRef.Name, assets.NormalizePackagePath(mp), matObj);
                            }
                        }
                    }
                }
            }

            foreach (var mc in compMap.Values)
            {
                if (string.IsNullOrEmpty(mc.MeshPath)) continue;
                // Skip primary character body components
                if (mc.Name.Equals("CharacterMesh0", StringComparison.OrdinalIgnoreCase) ||
                    mc.Name.Equals("Mesh", StringComparison.OrdinalIgnoreCase) ||
                    mc.Name.StartsWith("SkeletalMeshComponent", StringComparison.OrdinalIgnoreCase))
                    continue;
                if (mc.MeshPath.EndsWith($"/{variantId}", StringComparison.OrdinalIgnoreCase))
                    continue;
                // Skip LOD/proxy/vehicle/BKM/SMM clutter
                var meshFn = Path.GetFileName(mc.MeshPath);
                if (meshFn.Contains("_Simple", StringComparison.OrdinalIgnoreCase) ||
                    meshFn.Contains("_Low", StringComparison.OrdinalIgnoreCase) ||
                    meshFn.Contains("_Shadow", StringComparison.OrdinalIgnoreCase) ||
                    meshFn.EndsWith("_SMM", StringComparison.OrdinalIgnoreCase) ||
                    meshFn.EndsWith("_BKM", StringComparison.OrdinalIgnoreCase))
                    continue;

                // Deduplicate identical mesh + socket combos across BP variants
                var dedupKey = $"{mc.MeshPath}|{mc.AttachSocket ?? ""}";
                if (!seenMeshes.Add(dedupKey)) continue;

                string partKind = mc.Name.Contains("WeaponCase", StringComparison.OrdinalIgnoreCase)
                    ? "WeaponProp"
                    : (mc.Name.Contains("OtherCase", StringComparison.OrdinalIgnoreCase) ||
                       mc.MeshPath.Contains("/Prop/", StringComparison.OrdinalIgnoreCase) ||
                       meshFn.StartsWith("Shipin_", StringComparison.OrdinalIgnoreCase))
                        ? "Prop"
                        : "Modular";

                // Only Seq_Link / non-alt _Seq_V2 static hairpins/accessories default to visible;
                // combat OtherCase*, WeaponCase*, and Rover element props start hidden until toggled or activated by a Form preset.
                bool defaultVis = isSeqBp
                               && !isAltFormSeqBp
                               && !isElementRoverBp
                               && partKind != "WeaponProp"
                               && !meshFn.Contains("_Up", StringComparison.OrdinalIgnoreCase)
                               && !meshFn.Contains("_Hair", StringComparison.OrdinalIgnoreCase)
                               && !meshFn.Contains("_Tail", StringComparison.OrdinalIgnoreCase)
                               && !meshFn.Contains("_Body", StringComparison.OrdinalIgnoreCase)
                               && !mc.Name.Contains("OtherCase", StringComparison.OrdinalIgnoreCase)
                               && mc.Visible
                               && !mc.HiddenInGame;

                var labelName = isElementRoverBp && !mc.Name.Contains(bpName[3..], StringComparison.OrdinalIgnoreCase)
                    ? $"{bpName[3..]}_{mc.Name}"
                    : mc.Name;

                result.Add(new CharacterPartDto(
                    labelName,
                    mc.MeshPath,
                    mc.AttachParent,
                    mc.AttachSocket,
                    mc.RelPos,
                    mc.RelQuat,
                    mc.RelScale,
                    DefaultVisible: defaultVis,
                    PartKind: partKind,
                    OverrideMaterials: mc.OverrideMaterials is { Count: > 0 } ? mc.OverrideMaterials : null));
            }
        }

        return result;
    }

    private sealed class MutableBpComp
    {
        public string Name = "";
        public string? MeshPath;
        public string? AttachParent;
        public string? AttachSocket;
        public float[]? RelPos;
        public float[]? RelQuat;
        public float[]? RelScale;
        public bool Visible = true;
        public bool HiddenInGame = false;
        public Dictionary<int, MaterialSlotDto>? OverrideMaterials;
    }

    public async Task<ModelFormMaterialsDto?> ResolveFormMaterialsAsync(string meshPath)
    {
        var normMesh = assets.NormalizePackagePath(meshPath);
        var manifest = await GetModelManifestAsync(normMesh);
        if (manifest == null) return null;

        // Folder hierarchy: .../Character/Role/<Body>/<Char>/<code>/Model/<MeshName>
        var modelDir = Path.GetDirectoryName(normMesh)?.Replace('\\', '/');
        if (string.IsNullOrEmpty(modelDir)) return new ModelFormMaterialsDto(normMesh, []);
        var codeDir = modelDir.EndsWith("/Model", StringComparison.OrdinalIgnoreCase)
            ? modelDir[..^"/Model".Length]
            : modelDir;

        var candidateFiles = assets.AllUAssets
            .Where(f => f.StartsWith(codeDir + "/", StringComparison.OrdinalIgnoreCase)
                     && (f.Contains("/Model/", StringComparison.OrdinalIgnoreCase) || f.Contains("/Seq/", StringComparison.OrdinalIgnoreCase)))
            .Select(f => f[..^7])
            .Where(noExt =>
            {
                var fn = Path.GetFileName(noExt);
                return !fn.Contains("_Simple", StringComparison.OrdinalIgnoreCase)
                    && !fn.Contains("_Low", StringComparison.OrdinalIgnoreCase)
                    && !fn.EndsWith("_OL", StringComparison.OrdinalIgnoreCase)
                    && !fn.EndsWith("_FS", StringComparison.OrdinalIgnoreCase)
                    && !fn.Contains("_Shadow", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();

        var miFiles = candidateFiles.Where(f => Path.GetFileName(f).StartsWith("MI_", StringComparison.OrdinalIgnoreCase)).ToList();
        var texFiles = candidateFiles.Where(f => Path.GetFileName(f).StartsWith("T_", StringComparison.OrdinalIgnoreCase)).ToList();

        var texByName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var tf in texFiles)
            texByName.TryAdd(Path.GetFileName(tf), tf);

        var presetsByTag = new Dictionary<string, Dictionary<string, MaterialSlotDto>>(StringComparer.OrdinalIgnoreCase);
        Dictionary<string, MaterialSlotDto> GetTagMap(string tag)
        {
            if (!presetsByTag.TryGetValue(tag, out var m))
                presetsByTag[tag] = m = new Dictionary<string, MaterialSlotDto>(StringComparer.OrdinalIgnoreCase);
            return m;
        }

        // 1. Alternate MI_ files
        var baseMiPaths = new HashSet<string>(manifest.Materials.Select(m => m.AssetPath), StringComparer.OrdinalIgnoreCase);
        var knownTags = new[] { "Switch03", "Switch02", "Switch", "Change", "Seq04", "Seq02", "Damage", "BlendWater" };

        foreach (var miPath in miFiles)
        {
            if (baseMiPaths.Contains(miPath)) continue;
            var miName = Path.GetFileName(miPath);

            string? matchedTag = knownTags.FirstOrDefault(t => miName.Contains(t, StringComparison.OrdinalIgnoreCase));
            MaterialSlotDto? targetBaseSlot = null;

            if (matchedTag != null)
            {
                var stripped = System.Text.RegularExpressions.Regex.Replace(
                    miName,
                    $"[_]?{System.Text.RegularExpressions.Regex.Escape(matchedTag)}",
                    "",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                targetBaseSlot = manifest.Materials.FirstOrDefault(s =>
                    s.ShaderType != "Outline" && s.ShaderType != "FaceShadow" &&
                    (s.Name.Equals(stripped, StringComparison.OrdinalIgnoreCase) ||
                     stripped.Replace("01", "").Equals(s.Name.Replace("01", ""), StringComparison.OrdinalIgnoreCase)));
            }
            else if (miName.EndsWith("02", StringComparison.OrdinalIgnoreCase) || miName.EndsWith("03", StringComparison.OrdinalIgnoreCase))
            {
                matchedTag = miName[^2..];
                var base01 = miName[..^2] + "01";
                var baseNoNum = miName[..^2];
                targetBaseSlot = manifest.Materials.FirstOrDefault(s =>
                    s.ShaderType != "Outline" && s.ShaderType != "FaceShadow" &&
                    (s.Name.Equals(base01, StringComparison.OrdinalIgnoreCase) ||
                     s.Name.Equals(baseNoNum, StringComparison.OrdinalIgnoreCase)));
            }

            if (matchedTag != null && targetBaseSlot != null && assets.TryLoadPackageSafe(miPath, out var miPkg))
            {
                var matObj = miPkg.ExportsLazy.Select(e => e.Value).OfType<UMaterialInterface>().FirstOrDefault();
                if (matObj != null)
                {
                    var slotDto = ExtractMaterialSlot(targetBaseSlot.Index, miName, miPath, matObj);
                    GetTagMap(matchedTag)[targetBaseSlot.Name] = slotDto;
                }
            }
        }

        // 2. Alternate T_ textures (clone base MaterialSlotDto with swapped texture paths)
        var chanRegex = new System.Text.RegularExpressions.Regex(@"(_D|_N|_ID|_HM|_M|_E|_ORM|_S)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var tagNames = new (string Tag, string[] Inserts)[]
        {
            ("Switch03", ["_Switch03", "Switch03"]),
            ("Switch02", ["_Switch02", "Switch02"]),
            ("Switch",   ["_Switch", "Switch"]),
            ("Change",   ["_Change", "Change"]),
            ("Seq04",    ["_Seq04", "Seq04"]),
            ("Seq02",    ["_Seq02", "Seq02"]),
            ("Damage",   ["_Damage", "Damage"]),
        };

        foreach (var slot in manifest.Materials)
        {
            if (slot.ShaderType == "Outline" || slot.ShaderType == "FaceShadow" || slot.ShaderType == "Distortion")
                continue;

            foreach (var (paramKey, baseTexPath) in slot.Textures)
            {
                if (string.IsNullOrEmpty(baseTexPath)) continue;
                var baseTexName = Path.GetFileName(baseTexPath);
                var chanMatch = chanRegex.Match(baseTexName);
                var chan = chanMatch.Success ? chanMatch.Value : "";
                var stem = chanMatch.Success ? baseTexName[..^chan.Length] : baseTexName;
                var stemNo01 = stem.EndsWith("01", StringComparison.OrdinalIgnoreCase)
                    ? stem[..^2]
                    : (stem.EndsWith("1", StringComparison.OrdinalIgnoreCase) && !stem.Contains("Md1", StringComparison.OrdinalIgnoreCase) ? stem[..^1] : null);

                void TryAssignTex(string tag, string candName)
                {
                    if (!texByName.TryGetValue(candName, out var candPath)) return;
                    var tagMap = GetTagMap(tag);
                    // Preserve full MI_ override if one already exists for this slot, else accumulate texture swaps on a cloned slot
                    if (!tagMap.TryGetValue(slot.Name, out var existing))
                    {
                        existing = slot with { Textures = new Dictionary<string, string>(slot.Textures, StringComparer.OrdinalIgnoreCase) };
                        tagMap[slot.Name] = existing;
                    }
                    else if (!existing.AssetPath.Equals(slot.AssetPath, StringComparison.OrdinalIgnoreCase))
                    {
                        return;
                    }
                    existing.Textures[paramKey] = candPath;
                }

                foreach (var (tag, inserts) in tagNames)
                {
                    foreach (var ins in inserts)
                    {
                        TryAssignTex(tag, $"{stem}{ins}{chan}");
                        if (stemNo01 != null)
                            TryAssignTex(tag, $"{stemNo01}{ins}{chan}");
                    }
                }

                if (stemNo01 != null)
                {
                    TryAssignTex("02", $"{stemNo01}02{chan}");
                    TryAssignTex("02", $"{stemNo01}2{chan}");
                    TryAssignTex("02", $"{stemNo01}_2{chan}");
                    TryAssignTex("03", $"{stemNo01}03{chan}");
                    TryAssignTex("03", $"{stemNo01}3{chan}");
                }
            }
        }

        var presetLabels = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Switch03"] = "변신 상태 3 (Switch03)",
            ["Switch02"] = "변신 상태 2 (Switch02)",
            ["Switch"] = "상태 전환 (Switch)",
            ["Change"] = "외형 변화 (Change)",
            ["Seq04"] = "컷신/변신 (Seq04)",
            ["Seq02"] = "컷신/변신 (Seq02)",
            ["Damage"] = "전투 손상 (Damage)",
            ["BlendWater"] = "수중 블렌드 (BlendWater)",
            ["02"] = "변신 스킨 (02)",
            ["03"] = "변신 스킨 (03)",
        };

        var presets = presetsByTag
            .Where(kv => kv.Value.Count > 0)
            .Select(kv => new ModelMaterialPresetDto(
                kv.Key,
                presetLabels.TryGetValue(kv.Key, out var lbl) ? lbl : kv.Key,
                kv.Value))
            .OrderBy(p => p.Tag)
            .ToList();

        return new ModelFormMaterialsDto(normMesh, presets);
    }

    private (ModelManifestDto Manifest, byte[] GlbBytes) BuildSkeletalMeshManifestAndGlb(string norm, USkeletalMesh skMesh)
    {
        using var dto = new SkeletalMeshDto(skMesh, MeshExportOpts);
        var glbFiles = new GltfMeshFormat().BuildSkeletalMesh(skMesh.Name, norm, MeshExportOpts, dto);
        if (glbFiles.Count == 0)
            throw new InvalidOperationException($"GltfMeshFormat produced 0 files for {norm}");

        var glbBytes = glbFiles[0].Data;

        var matSlots = new List<MaterialSlotDto>();
        for (int i = 0; i < skMesh.Materials.Length; i++)
        {
            var matRef = skMesh.Materials[i];
            var matObj = matRef?.Load<UMaterialInterface>();
            var matPath = matRef?.ResolvedObject?.GetPathName() ?? "";
            matSlots.Add(ExtractMaterialSlot(i, matRef?.Name ?? $"Mat_{i}", assets.NormalizePackagePath(matPath), matObj));
        }

        // Map base sections (matching enabled sections exported by Gltf)
        var sections = new List<MeshSectionDto>();
        var lod0 = skMesh.LODModels[0];
        int activeIdx = 0;
        for (int s = 0; s < lod0.Sections.Length; s++)
        {
            var sec = lod0.Sections[s];
            if (sec.bDisabled) continue;
            var mIdx = sec.MaterialIndex;
            var baseMat = (mIdx >= 0 && mIdx < matSlots.Count) ? matSlots[mIdx] : null;
            var baseName = baseMat?.Name ?? $"Mat_{mIdx}";

            int? olIdx = FindOverlayMaterialIndex(matSlots, baseName, "_OL");
            if (olIdx == null && baseName.Contains("Eye", StringComparison.OrdinalIgnoreCase))
                olIdx = FindOverlayMaterialIndex(matSlots, "MI_Eye", "_OL");
            int? fsIdx = FindOverlayMaterialIndex(matSlots, baseName, "_FS");
            int? hetaIdx = FindOverlayMaterialIndex(matSlots, baseName, "_HETA")
                        ?? FindOverlayMaterialIndex(matSlots, baseName, "_HET");

            sections.Add(new MeshSectionDto(
                activeIdx++,
                mIdx,
                baseName,
                sec.NumTriangles,
                sec.bDisabled,
                sec.bCastShadow,
                olIdx,
                fsIdx,
                hetaIdx));
        }

        var sockets = new List<SocketDto>();
        foreach (var sockIdx in skMesh.Sockets)
        {
            if (sockIdx?.TryLoad<USkeletalMeshSocket>(out var s) == true)
            {
                sockets.Add(new SocketDto(
                    s.SocketName.Text,
                    s.BoneName.Text,
                    CoordConvert.SwapPos(s.RelativeLocation),
                    CoordConvert.SwapRotatorToQuat(s.RelativeRotation),
                    CoordConvert.SwapScale(s.RelativeScale)));
            }
        }

        USkeleton? skel = skMesh.Skeleton?.Load<USkeleton>();
        if (skel != null)
        {
            foreach (var sockIdx in skel.Sockets)
            {
                if (sockIdx?.TryLoad<USkeletalMeshSocket>(out var s) == true &&
                    sockets.All(x => !x.Name.Equals(s.SocketName.Text, StringComparison.OrdinalIgnoreCase)))
                {
                    sockets.Add(new SocketDto(
                        s.SocketName.Text,
                        s.BoneName.Text,
                        CoordConvert.SwapPos(s.RelativeLocation),
                        CoordConvert.SwapRotatorToQuat(s.RelativeRotation),
                        CoordConvert.SwapScale(s.RelativeScale)));
                }
            }
        }

        var morphNames = skMesh.MorphTargets
            .Select((m, idx) => m?.Name ?? $"Morph_{idx}")
            .ToList();

        var manifest = new ModelManifestDto(
            norm,
            skMesh.Name,
            "SkeletalMesh",
            skel?.Name,
            skMesh.Skeleton?.ResolvedObject?.GetPathName() is { } sp ? assets.NormalizePackagePath(sp) : null,
            $"/api/model/glb?path={Uri.EscapeDataString(norm)}",
            matSlots,
            sections,
            sockets,
            morphNames);

        return (manifest, glbBytes);
    }

    private (ModelManifestDto Manifest, byte[] GlbBytes) BuildStaticMeshManifestAndGlb(string norm, UStaticMesh stMesh)
    {
        using var dto = new StaticMeshDto(stMesh, MeshExportOpts);
        var glbFiles = new GltfMeshFormat().BuildStaticMesh(stMesh.Name, norm, MeshExportOpts, dto);
        if (glbFiles.Count == 0)
            throw new InvalidOperationException($"GltfMeshFormat produced 0 files for {norm}");

        var glbBytes = glbFiles[0].Data;

        var matSlots = new List<MaterialSlotDto>();
        for (int i = 0; i < stMesh.Materials.Length; i++)
        {
            var matRef = stMesh.Materials[i];
            var matObj = matRef?.Load<UMaterialInterface>();
            var matPath = matRef?.ResolvedObject?.GetPathName() ?? "";
            matSlots.Add(ExtractMaterialSlot(i, matRef?.Name ?? $"Mat_{i}", assets.NormalizePackagePath(matPath), matObj));
        }

        var sections = new List<MeshSectionDto>();
        var lod0 = stMesh.RenderData?.LODs.FirstOrDefault();
        if (lod0 != null)
        {
            for (int i = 0; i < lod0.Sections.Length; i++)
            {
                var sec = lod0.Sections[i];
                var mIdx = sec.MaterialIndex;
                var name = (mIdx >= 0 && mIdx < matSlots.Count) ? matSlots[mIdx].Name : $"Mat_{mIdx}";
                sections.Add(new MeshSectionDto(i, mIdx, name, sec.NumTriangles, false, sec.bCastShadow, null, null, null));
            }
        }

        var manifest = new ModelManifestDto(
            norm,
            stMesh.Name,
            "StaticMesh",
            null,
            null,
            $"/api/model/glb?path={Uri.EscapeDataString(norm)}",
            matSlots,
            sections,
            [],
            []);

        return (manifest, glbBytes);
    }

    private static int? FindOverlayMaterialIndex(List<MaterialSlotDto> mats, string baseName, string suffix)
    {
        var target = baseName + suffix;
        var exact = mats.FirstOrDefault(m => m.Name.Equals(target, StringComparison.OrdinalIgnoreCase));
        if (exact != null) return exact.Index;

        // Try matching stem after removing Mi_ prefix / variant differences
        var byEnd = mats.FirstOrDefault(m => m.Name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) &&
                                             m.Name.Contains(baseName, StringComparison.OrdinalIgnoreCase));
        return byEnd?.Index;
    }

    private MaterialSlotDto ExtractMaterialSlot(int index, string name, string assetPath, UMaterialInterface? mat)
    {
        var scalars = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        var vectors = new Dictionary<string, float[]>(StringComparer.OrdinalIgnoreCase);
        var switches = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        var textures = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        bool twoSided = false;
        string blendMode = "BLEND_Opaque";
        string? immediateParentName = null;

        if (mat != null)
        {
            // Collect hierarchy from root to child
            var chain = new List<UMaterialInterface>();
            UMaterialInterface? cur = mat;
            int guard = 0;
            while (cur != null && guard++ < 16)
            {
                chain.Add(cur);
                if (cur is UMaterialInstance mi)
                {
                    if (immediateParentName == null)
                        immediateParentName = mi.Parent?.Name;
                    cur = mi.Parent?.TryLoad<UMaterialInterface>(out var parentObj) == true && parentObj != cur ? parentObj : null;
                }
                else
                {
                    break;
                }
            }

            chain.Reverse();
            foreach (var node in chain)
            {
                if (node is UMaterial baseMat)
                {
                    twoSided = baseMat.TwoSided;
                    blendMode = baseMat.BlendMode.ToString();
                }
                else if (node is UMaterialInstance mi)
                {
                    if (mi.BasePropertyOverrides != null)
                    {
                        if (mi.BasePropertyOverrides.bOverride_TwoSided)
                            twoSided = mi.BasePropertyOverrides.TwoSided;
                        if (mi.BasePropertyOverrides.bOverride_BlendMode)
                            blendMode = mi.BasePropertyOverrides.BlendMode.ToString();
                    }

                    if (mi.StaticParameters != null)
                    {
                        foreach (var sw in mi.StaticParameters.StaticSwitchParameters)
                        {
                            switches[sw.Name] = sw.Value;
                        }
                    }

                    if (mi is UMaterialInstanceConstant mic)
                    {
                        foreach (var sc in mic.ScalarParameterValues)
                            scalars[sc.ParameterInfo.Name.Text] = sc.ParameterValue;

                        foreach (var vc in mic.VectorParameterValues)
                        {
                            if (vc.ParameterValue is { } col)
                                vectors[vc.ParameterInfo.Name.Text] = [col.R, col.G, col.B, col.A];
                        }

                        foreach (var tx in mic.TextureParameterValues)
                        {
                            var p = tx.ParameterValue?.ResolvedObject?.GetPathName();
                            if (!string.IsNullOrEmpty(p))
                                textures[tx.ParameterInfo.Name.Text] = assets.NormalizePackagePath(p);
                        }
                    }
                }
            }
        }

        AttachWetOverlayMetadata(name, assetPath, scalars, switches);
        var shaderType = ClassifyShaderType(name, immediateParentName, textures);

        return new MaterialSlotDto(
            index,
            name,
            assetPath,
            immediateParentName,
            shaderType,
            twoSided,
            blendMode,
            scalars,
            vectors,
            switches,
            textures);
    }

    private static string ClassifyShaderType(string name, string? parentName, Dictionary<string, string>? textures = null)
    {
        if (name.EndsWith("_OL", StringComparison.OrdinalIgnoreCase) || (parentName?.Contains("OL", StringComparison.OrdinalIgnoreCase) == true))
            return "Outline";
        if (name.EndsWith("_FS", StringComparison.OrdinalIgnoreCase) ||
            name.EndsWith("_Shadow", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("FaceShadow", StringComparison.OrdinalIgnoreCase) ||
            parentName?.Contains("FaceShadow", StringComparison.OrdinalIgnoreCase) == true)
            return "FaceShadow";
        if (name.Contains("Distortion", StringComparison.OrdinalIgnoreCase) ||
            parentName?.Contains("Distortion", StringComparison.OrdinalIgnoreCase) == true ||
            ((name.EndsWith("_FX", StringComparison.OrdinalIgnoreCase) || name.Contains("FX_", StringComparison.OrdinalIgnoreCase)) &&
             (textures == null || (!textures.ContainsKey("MainTex") && !textures.ContainsKey("BaseColor") && !textures.ContainsKey("Base")))))
            return "Distortion";
        if (name.EndsWith("_HETA", StringComparison.OrdinalIgnoreCase) || name.EndsWith("_HET", StringComparison.OrdinalIgnoreCase))
            return "HETA";
        if (parentName?.Contains("SimpleEffect", StringComparison.OrdinalIgnoreCase) == true ||
            parentName?.Contains("AdvancedEffect", StringComparison.OrdinalIgnoreCase) == true ||
            (textures != null && textures.ContainsKey("Base") && !textures.ContainsKey("MainTex")))
            return "Standard";
        if (name.Contains("Face", StringComparison.OrdinalIgnoreCase) || parentName?.Contains("Face", StringComparison.OrdinalIgnoreCase) == true)
            return "Face";
        if (name.Contains("Eye", StringComparison.OrdinalIgnoreCase) || parentName?.Contains("Eye", StringComparison.OrdinalIgnoreCase) == true)
            return "Eye";
        if (name.Contains("Hair", StringComparison.OrdinalIgnoreCase) || name.Contains("Bangs", StringComparison.OrdinalIgnoreCase) || parentName?.Contains("Hair", StringComparison.OrdinalIgnoreCase) == true)
            return "Hair";
        if (name.Contains("Body", StringComparison.OrdinalIgnoreCase) || name.Contains("Up", StringComparison.OrdinalIgnoreCase) || name.Contains("Down", StringComparison.OrdinalIgnoreCase) || name.Contains("Cloth", StringComparison.OrdinalIgnoreCase) || parentName?.Contains("Body", StringComparison.OrdinalIgnoreCase) == true)
            return "Body";
        return "Standard";
    }
}
