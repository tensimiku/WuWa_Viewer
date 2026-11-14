using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;
using CUE4Parse.Compression;
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Versions;
using CUE4Parse.Utils;
using Microsoft.Extensions.Options;
using Newtonsoft.Json;
using WuWaViewer.Server.Models;

namespace WuWaViewer.Server.Services;

public sealed partial class GameAssetService : IDisposable
{
    private readonly ILogger<GameAssetService> _logger;
    private readonly ViewerOptions _options;
    private readonly IHostEnvironment _env;
    private readonly object _providerLock = new();

    public DefaultFileProvider Provider { get; private set; } = null!;
    public string CacheDir { get; }
    public List<string> AllUAssets { get; private set; } = [];
    public List<CharacterSummaryDto> Characters { get; private set; } = [];
    public List<WeaponSummaryDto> Weapons { get; private set; } = [];
    public List<CutsceneSummaryDto> Cutscenes { get; private set; } = [];
    public ConcurrentDictionary<string, CharacterSummaryDto> CharacterMap { get; } = new(StringComparer.OrdinalIgnoreCase);

    private readonly Dictionary<string, List<string>> _sharedBaseAnims = new(StringComparer.OrdinalIgnoreCase);

    public GameAssetService(IOptions<ViewerOptions> options, IHostEnvironment env, ILogger<GameAssetService> logger)
    {
        _logger = logger;
        _env = env;
        _options = options.Value;
        CacheDir = ResolveCacheDir(_options.CacheDir, _env.ContentRootPath);
        Directory.CreateDirectory(CacheDir);
    }

    public async Task InitializeAsync()
    {
        var sw = Stopwatch.StartNew();
        EnsureNativeBinaryInAppDir("CUE4Parse-Natives.dll");
        EnsureNativeBinaryInAppDir(OodleHelper.OodleFileName);

        var oodlePath = Path.Combine(AppContext.BaseDirectory, OodleHelper.OodleFileName);
        await OodleHelper.InitializeAsync(oodlePath);
        if (OodleHelper.Instance is null)
        {
            throw new FileNotFoundException(
                $"Missing or failed to download Oodle DLL ({OodleHelper.OodleFileName}) at '{oodlePath}'. Place it in '{oodlePath}' or 'WuWaViewer.Server/native/'.",
                oodlePath);
        }

        if (!CUE4ParseNatives.IsInitialized)
        {
            _logger.LogWarning(
                "CUE4Parse-Natives library was not found at startup; ACL-compressed animations require CUE4Parse-Natives.dll in '{BaseDir}' or 'WuWaViewer.Server/native/'.",
                AppContext.BaseDirectory);
        }

        var gameDir = Environment.ExpandEnvironmentVariables(_options.GameDir ?? string.Empty).Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(gameDir))
        {
            throw new InvalidOperationException(
                "WuWaViewer:GameDir is not configured. Copy .env.example to .env (or WuWaViewer.Server/appsettings.Local.example.json to WuWaViewer.Server/appsettings.Local.json) and set WUWA_GAME_DIR / WuWaViewer:GameDir to your Wuthering Waves installation folder.");
        }

        var paksDir = new DirectoryInfo(Path.Combine(gameDir, "Client", "Content", "Paks"));
        if (!paksDir.Exists)
        {
            throw new DirectoryNotFoundException(
                $"Configured GameDir does not contain Client/Content/Paks: '{gameDir}'. Verify WUWA_GAME_DIR / WuWaViewer:GameDir points to the Wuthering Waves root game folder.");
        }

        var extraDirs = new List<DirectoryInfo>();
        var hdDir = new DirectoryInfo(Path.Combine(gameDir, "Client", "Content", "HD"));
        if (hdDir.Exists) extraDirs.Add(hdDir);

        var resRoot = Path.Combine(gameDir, "Client", "Saved", "Resources");
        if (Directory.Exists(resRoot))
        {
            foreach (var verDir in Directory.GetDirectories(resRoot))
            {
                var verName = Path.GetFileName(verDir);
                if (verName.Equals("Video", StringComparison.OrdinalIgnoreCase)) continue;
                foreach (var sub in Directory.GetDirectories(verDir))
                {
                    var name = Path.GetFileName(sub);
                    if (name.StartsWith("RoleVoice", StringComparison.OrdinalIgnoreCase) ||
                        name.Equals("Diff", StringComparison.OrdinalIgnoreCase) ||
                        name.Equals("Mount", StringComparison.OrdinalIgnoreCase) ||
                        name.Equals("ResManifest", StringComparison.OrdinalIgnoreCase) ||
                        name.StartsWith("Lang_", StringComparison.OrdinalIgnoreCase))
                        continue;
                    extraDirs.Add(new DirectoryInfo(sub));
                }
            }
        }

        Provider = new DefaultFileProvider(
            paksDir,
            extraDirs.ToArray(),
            SearchOption.AllDirectories,
            new VersionContainer(EGame.GAME_WutheringWaves),
            StringComparer.OrdinalIgnoreCase);

        Provider.Initialize();

        var keysFullPath = ResolveKeysPath(_options.KeysPath, _env.ContentRootPath);
        if (!File.Exists(keysFullPath))
        {
            throw new FileNotFoundException(
                $"AES keys file not found at '{keysFullPath}'. Clone https://github.com/yarik0chka/wuwa-keys into ./wuwa-keys (or copy keys.example.json and set WUWA_KEYS_PATH / WuWaViewer:KeysPath).",
                keysFullPath);
        }

        var keysJson = JsonConvert.DeserializeObject<KeyFile>(await File.ReadAllTextAsync(keysFullPath))
            ?? throw new InvalidOperationException("Failed to deserialize keys.json");
        var submitList = new List<KeyValuePair<FGuid, FAesKey>> { new(new FGuid(), new FAesKey(keysJson.mainKey)) };
        foreach (var dk in keysJson.dynamicKeys)
            submitList.Add(new(new FGuid(dk.guid), new FAesKey(dk.key)));

        Provider.SubmitKeys(submitList);
        Provider.LoadVirtualPaths();

        _logger.LogInformation("Mounted {Vfs} VFS archives ({Files} files) in {Ms} ms",
            Provider.MountedVfs.Count, Provider.Files.Count, sw.ElapsedMilliseconds);

        BuildIndices();
        _logger.LogInformation("Indexed {Chars} characters, {Weapons} weapons, {Cutscenes} cutscenes in {Ms} ms",
            Characters.Count, Weapons.Count, Cutscenes.Count, sw.ElapsedMilliseconds);
    }

    public string NormalizePackagePath(string path)
    {
        var p = path.Replace('\\', '/').Trim();
        if (p.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            p = p[..^7];
        var dot = p.LastIndexOf('.');
        var slash = p.LastIndexOf('/');
        if (dot > slash) p = p[..dot];
        if (p.StartsWith("/Game/", StringComparison.OrdinalIgnoreCase))
            p = "Client/Content/" + p["/Game/".Length..];
        else if (p.StartsWith("Game/", StringComparison.OrdinalIgnoreCase))
            p = "Client/Content/" + p["Game/".Length..];
        else if (!p.StartsWith("Client/", StringComparison.OrdinalIgnoreCase) && !p.StartsWith("Engine/", StringComparison.OrdinalIgnoreCase))
            p = "Client/Content/" + p.TrimStart('/');
        return p;
    }

    public bool TryLoadPackageSafe(string packagePath, out CUE4Parse.UE4.Assets.IPackage package)
    {
        var norm = NormalizePackagePath(packagePath);
        lock (_providerLock)
        {
            return Provider.TryLoadPackage(norm, out package!);
        }
    }

    public T? LoadObjectSafe<T>(string packagePath) where T : CUE4Parse.UE4.Assets.Exports.UObject
    {
        var norm = NormalizePackagePath(packagePath);
        lock (_providerLock)
        {
            return Provider.TryLoadPackageObject<T>(norm, out var obj) ? obj : null;
        }
    }

    private void BuildIndices()
    {
        AllUAssets = Provider.Files.Keys
            .Where(k => k.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .Select(k => k.Replace('\\', '/'))
            .ToList();

        // 1. Weapons & Character Props index
        Weapons = AllUAssets
            .Where(k => k.StartsWith("Client/Content/Aki/Character/Weapon/", StringComparison.OrdinalIgnoreCase)
                     && k.Contains("/Model/", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("_Low", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("_Simple", StringComparison.OrdinalIgnoreCase))
            .Where(k =>
            {
                var fn = Path.GetFileNameWithoutExtension(k);
                return !fn.StartsWith("T_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("MI_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("M_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("P_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("DA_", StringComparison.OrdinalIgnoreCase)
                    && !fn.Contains("_Skeleton", StringComparison.OrdinalIgnoreCase)
                    && !fn.Contains("_Physics", StringComparison.OrdinalIgnoreCase)
                    && !fn.Contains("_Shadow", StringComparison.OrdinalIgnoreCase);
            })
            .Select(k =>
            {
                var noExt = k[..^7];
                var parts = noExt.Split('/');
                var cat = parts.Length > 5 ? parts[5] : "Weapon";
                var wName = parts.Length > 6 ? parts[6] : Path.GetFileNameWithoutExtension(k);
                return new WeaponSummaryDto(noExt, $"{wName} ({Path.GetFileName(noExt)})", noExt, cat);
            })
            .OrderBy(w => w.Category).ThenBy(w => w.Name)
            .ToList();

        // 2. Cutscene LevelSequence index (excluding animations, blueprints, VFX, media/UI helper assets)
        var seqCandidates = AllUAssets
            .Where(k => k.StartsWith("Client/Content/Aki/Sequence/", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/SequenceAnim/", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/Anim/", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/Ani/", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/DA_Face/", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/Generated/", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/Mat/", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/BP/", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/SplitScreen", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/PostProcess", StringComparison.OrdinalIgnoreCase)
                     && !k.Contains("/Audio/", StringComparison.OrdinalIgnoreCase))
            .Where(k =>
            {
                var fn = Path.GetFileNameWithoutExtension(k);
                return !fn.StartsWith("VO_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("DA_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("BP_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("Generated_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("Camera_Shake", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("T_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("MI_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("M_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("SM_", StringComparison.OrdinalIgnoreCase)
                    && !fn.StartsWith("SK_", StringComparison.OrdinalIgnoreCase)
                    && !fn.EndsWith("_C", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();

        Cutscenes = seqCandidates.Select(k =>
        {
            var noExt = k[..^7];
            var name = Path.GetFileName(noExt);
            var cat = k.Contains("/DrawCard/", StringComparison.OrdinalIgnoreCase) ? "DrawCard"
                    : k.Contains("/Main", StringComparison.OrdinalIgnoreCase) ? "MainStory"
                    : k.Contains("/RoleQuest", StringComparison.OrdinalIgnoreCase) || k.Contains("/Quest/", StringComparison.OrdinalIgnoreCase) ? "RoleQuest"
                    : k.Contains("/Fight", StringComparison.OrdinalIgnoreCase) || k.Contains("/Common_Seq", StringComparison.OrdinalIgnoreCase) ? "Combat"
                    : "Other";
            return new CutsceneSummaryDto(noExt, name, noExt, cat, null);
        }).OrderBy(c => c.Category).ThenBy(c => c.Name).ToList();

        // 3. Shared BaseAnim per body type
        foreach (var k in AllUAssets.Where(f => f.StartsWith("Client/Content/Aki/Character/Role/", StringComparison.OrdinalIgnoreCase)))
        {
            var parts = k.Split('/');
            if (parts.Length >= 9 && parts[6].StartsWith("BaseAnim", StringComparison.OrdinalIgnoreCase))
            {
                var body = parts[5];
                if (!_sharedBaseAnims.TryGetValue(body, out var list))
                    _sharedBaseAnims[body] = list = [];
                list.Add(k);
            }
        }

        // 4. Role Characters
        var ignoredDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "CommonTexture", "CommonData", "Common", "CapsuleAO", "Role_Lowest"
        };

        var charGroups = AllUAssets
            .Where(k => k.StartsWith("Client/Content/Aki/Character/Role/", StringComparison.OrdinalIgnoreCase))
            .Select(k => new { Path = k, Parts = k.Split('/') })
            .Where(x => x.Parts.Length >= 8
                     && !ignoredDirs.Contains(x.Parts[5])
                     && !x.Parts[6].StartsWith("BaseAnim", StringComparison.OrdinalIgnoreCase)
                     && !x.Parts[6].Equals("BasePhysics", StringComparison.OrdinalIgnoreCase))
            .GroupBy(x =>
            {
                var charDir = x.Parts[6].EndsWith("_Lifu", StringComparison.OrdinalIgnoreCase)
                    ? x.Parts[6][..^5]
                    : x.Parts[6];
                return $"{x.Parts[5]}/{charDir}";
            }, StringComparer.OrdinalIgnoreCase)
            .OrderBy(g => g.Key);

        var builtChars = new List<CharacterSummaryDto>();
        foreach (var g in charGroups)
        {
            var bodyType = g.First().Parts[5];
            var charName = g.Key.Split('/')[1];
            var charFiles = g.Select(x => x.Path).ToList();

            var variants = BuildVariants(bodyType, charName, charFiles);
            if (variants.Count == 0) continue;

            var hasPhysics = charFiles.Any(f =>
                Path.GetFileNameWithoutExtension(f).EndsWith("_PC", StringComparison.OrdinalIgnoreCase) ||
                Path.GetFileNameWithoutExtension(f).StartsWith("ABP_", StringComparison.OrdinalIgnoreCase));

            var animFiles = FindCharacterAnimationPaths(bodyType, charName, charFiles, includeShared: false);
            var matchedCutscenes = Cutscenes.Count(c =>
                c.Path.Contains($"/{charName}/", StringComparison.OrdinalIgnoreCase) ||
                c.Name.Contains(charName, StringComparison.OrdinalIgnoreCase));

            var suggestedWeapons = Weapons
                .Where(w => w.MeshPath.Contains(charName, StringComparison.OrdinalIgnoreCase))
                .Take(10)
                .ToList();

            var summary = new CharacterSummaryDto(
                g.Key,
                charName,
                bodyType,
                variants,
                suggestedWeapons,
                hasPhysics,
                animFiles.Count,
                matchedCutscenes);
            builtChars.Add(summary);
            CharacterMap[g.Key] = summary;
        }

        PopulateLinkedForms(builtChars);
        Characters = builtChars;
    }

    private void PopulateLinkedForms(List<CharacterSummaryDto> builtChars)
    {
        var linkPairs = new (string IdA, string NameA, string RelA, string IdB, string NameB, string RelB)[]
        {
            ("FemaleMS/Katixiya", "카르티시아 (기본 폼)", "BaseForm", "FemaleZ/Fuludelisi", "플뢰르 드 리스 (공명 해방 폼)", "LiberationForm"),
            ("FemaleM/Aimisi", "아미스 (기본 폼)", "BaseForm", "FemaleZ2/AimisiGD", "아미스 GD (메카 폼)", "MechForm"),
            ("FemaleXL/Xinyuehu", "신월호 (기본 폼)", "BaseForm", "FemaleXL/XinyuehuShen", "신월호·신 (각성 폼)", "AwakenedForm"),
        };

        foreach (var p in linkPairs)
        {
            if (!CharacterMap.ContainsKey(p.IdA) || !CharacterMap.ContainsKey(p.IdB))
                continue;

            var a = CharacterMap[p.IdA];
            var b = CharacterMap[p.IdB];

            CharacterMap[p.IdA] = a with
            {
                Variants = a.Variants.Select(v => v with
                {
                    LinkedForms = [new CharacterLinkedFormDto(p.IdB, p.NameB, p.RelB)]
                }).ToList()
            };
            CharacterMap[p.IdB] = b with
            {
                Variants = b.Variants.Select(v => v with
                {
                    LinkedForms = [new CharacterLinkedFormDto(p.IdA, p.NameA, p.RelA)]
                }).ToList()
            };
        }

        for (int i = 0; i < builtChars.Count; i++)
        {
            if (CharacterMap.TryGetValue(builtChars[i].Id, out var updated))
                builtChars[i] = updated;
        }
    }

    private List<CharacterVariantDto> BuildVariants(string bodyType, string charName, List<string> charFiles)
    {
        var variants = new List<CharacterVariantDto>();
        var mdGroups = charFiles
            .Select(f => new { Path = f, Parts = f.Split('/') })
            .Where(x => x.Parts.Length >= 9 && (
                x.Parts[7].StartsWith("R2T", StringComparison.OrdinalIgnoreCase) ||
                x.Parts[7].StartsWith("Skin", StringComparison.OrdinalIgnoreCase) ||
                x.Parts[7].StartsWith("NHT", StringComparison.OrdinalIgnoreCase)))
            .GroupBy(x => x.Parts[7], StringComparer.OrdinalIgnoreCase);

        var abpFiles = charFiles.Where(f => Path.GetFileNameWithoutExtension(f).StartsWith("ABP_", StringComparison.OrdinalIgnoreCase)).ToList();

        foreach (var mg in mdGroups)
        {
            var code = mg.Key;
            var groupFiles = mg.Select(x => x.Path).ToList();
            var modelMeshes = groupFiles
                .Where(f => f.Contains("/Model/", StringComparison.OrdinalIgnoreCase))
                .Select(f => f[..^7])
                .Where(noExt =>
                {
                    var fn = Path.GetFileName(noExt);
                    return (fn.StartsWith("R2T", StringComparison.OrdinalIgnoreCase)
                         || fn.StartsWith("NHT", StringComparison.OrdinalIgnoreCase)
                         || fn.StartsWith("Skin", StringComparison.OrdinalIgnoreCase))
                        && !fn.Contains("_Shadow", StringComparison.OrdinalIgnoreCase)
                        && !fn.Contains("_Simple", StringComparison.OrdinalIgnoreCase)
                        && !fn.Contains("_Low", StringComparison.OrdinalIgnoreCase)
                        && !fn.EndsWith("_Physics", StringComparison.OrdinalIgnoreCase)
                        && !fn.EndsWith("_PhysicsAsset", StringComparison.OrdinalIgnoreCase)
                        && !fn.EndsWith("_Skeleton", StringComparison.OrdinalIgnoreCase)
                        && !fn.EndsWith("_Rig", StringComparison.OrdinalIgnoreCase)
                        && !fn.Contains("PoseAsset", StringComparison.OrdinalIgnoreCase)
                        && !fn.Contains("SplitMorph", StringComparison.OrdinalIgnoreCase)
                        && !fn.EndsWith("_SMM", StringComparison.OrdinalIgnoreCase)
                        && !fn.EndsWith("_BKM", StringComparison.OrdinalIgnoreCase);
                })
                .OrderBy(m => Path.GetFileName(m).Length)
                .ToList();

            if (modelMeshes.Count == 0) continue;

            // Choose primary mesh (prefer exact code match, then base body/part 1)
            var hasExactCodeMesh = modelMeshes.Any(m => Path.GetFileName(m).Equals(code, StringComparison.OrdinalIgnoreCase));
            var primary = modelMeshes.FirstOrDefault(m => Path.GetFileName(m).Equals(code, StringComparison.OrdinalIgnoreCase))
                       ?? modelMeshes.FirstOrDefault(m => Path.GetFileName(m).EndsWith("_Up1", StringComparison.OrdinalIgnoreCase))
                       ?? modelMeshes.FirstOrDefault(m => Path.GetFileName(m).EndsWith("_Body", StringComparison.OrdinalIgnoreCase))
                       ?? modelMeshes[0];

            var extraParts = new List<CharacterPartDto>();
            var primaryFn = Path.GetFileName(primary);

            foreach (var m in modelMeshes.Where(m => !m.Equals(primary, StringComparison.OrdinalIgnoreCase)))
            {
                var fn = Path.GetFileName(m);
                bool defaultVis = !hasExactCodeMesh
                    && primaryFn.EndsWith("_Up1", StringComparison.OrdinalIgnoreCase)
                    && (fn.EndsWith("_Up2", StringComparison.OrdinalIgnoreCase) || fn.EndsWith("_Face", StringComparison.OrdinalIgnoreCase));

                extraParts.Add(new CharacterPartDto(
                    fn, m, null, null, null, null, null,
                    DefaultVisible: defaultVis,
                    PartKind: "Modular"));
            }

            var forms = BuildVariantForms(code, primary, modelMeshes, groupFiles, hasExactCodeMesh);

            // Pick best ABP for physics
            var abp = abpFiles.FirstOrDefault(a => Path.GetFileNameWithoutExtension(a).Contains(code, StringComparison.OrdinalIgnoreCase) && a.EndsWith("_PC.uasset", StringComparison.OrdinalIgnoreCase))
                   ?? abpFiles.FirstOrDefault(a => Path.GetFileNameWithoutExtension(a).Equals($"ABP_{code}_PC", StringComparison.OrdinalIgnoreCase))
                   ?? abpFiles.FirstOrDefault(a => a.Contains("_PC.uasset", StringComparison.OrdinalIgnoreCase) && !a.Contains("Performance", StringComparison.OrdinalIgnoreCase))
                   ?? abpFiles.FirstOrDefault(a => a.Contains("_PC.uasset", StringComparison.OrdinalIgnoreCase))
                   ?? abpFiles.FirstOrDefault();

            variants.Add(new CharacterVariantDto(
                code,
                code,
                primary,
                extraParts,
                abp?[..^7],
                forms.Count > 0 ? forms : null));
        }

        return variants
            .OrderBy(v => v.Id.Contains("Md10011", StringComparison.OrdinalIgnoreCase) ? 0
                        : v.Id.Contains("Md20011", StringComparison.OrdinalIgnoreCase) ? 1
                        : v.Id.StartsWith("R2T", StringComparison.OrdinalIgnoreCase) ? 2 : 3)
            .ThenBy(v => v.Id, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static List<CharacterFormDto> BuildVariantForms(
        string code,
        string primary,
        List<string> modelMeshes,
        List<string> groupFiles,
        bool hasExactCodeMesh)
    {
        string? FindPart(params string[] exactSuffixes)
        {
            foreach (var sfx in exactSuffixes)
            {
                var hit = modelMeshes.FirstOrDefault(m =>
                {
                    var fn = Path.GetFileName(m);
                    return fn.Equals($"{code}{sfx}", StringComparison.OrdinalIgnoreCase)
                        || fn.EndsWith(sfx, StringComparison.OrdinalIgnoreCase);
                });
                if (hit != null) return hit;
            }
            return null;
        }

        var bodyMesh = FindPart("_Body", "_body");
        var part1Mesh = FindPart("_1");
        var part3Mesh = FindPart("_3");
        var up1Mesh = FindPart("_Up1");
        var up2Mesh = FindPart("_Up2", "_up1");
        var up3Mesh = FindPart("_Up3");
        var hair2Mesh = FindPart("_Hair2");
        var hair3Mesh = FindPart("_Hair3");
        var tail2Mesh = FindPart("_Tail2");

        var forms = new List<CharacterFormDto>();

        // 1. Modular mesh swap forms
        if (up1Mesh != null && up3Mesh != null)
        {
            // e.g. Zanni: {code} full vs _Up1 + _Up3
            forms.Add(new CharacterFormDto(
                "form_up3",
                "변신 / 해방 폼 (_Up3)",
                "Modular",
                "해방 상태 헤어·의상 파츠 전환",
                OverridePrimaryMeshPath: up1Mesh,
                EnableParts: [Path.GetFileName(up3Mesh)]));
        }

        if (part1Mesh != null && part3Mesh != null)
        {
            // e.g. Kakaluo: {code} full vs _1 + _3
            forms.Add(new CharacterFormDto(
                "form_part3",
                "변신 / 공명 해방 (_3)",
                "Modular",
                "해방 상태 상의·외형 파츠 전환",
                OverridePrimaryMeshPath: part1Mesh,
                EnableParts: [Path.GetFileName(part3Mesh)]));
        }

        if (bodyMesh != null && up2Mesh != null)
        {
            // e.g. Daniya (_Body + _Up2), Luosela (_Body + _Up2), Rebecca (_body + _up1)
            forms.Add(new CharacterFormDto(
                "form_body_up2",
                $"변신 폼 ({Path.GetFileName(up2Mesh).Split('_').Last()})",
                "Modular",
                "변신 전용 바디 + 상체/얼굴 파츠 전환",
                OverridePrimaryMeshPath: bodyMesh,
                EnableParts: [Path.GetFileName(up2Mesh)]));
        }

        if (bodyMesh != null && hair2Mesh != null)
        {
            forms.Add(new CharacterFormDto(
                "form_hair2",
                "변신 헤어 2",
                "Modular",
                "헤어 변형 2단계 파츠 전환",
                OverridePrimaryMeshPath: bodyMesh,
                EnableParts: [Path.GetFileName(hair2Mesh)]));
        }

        if (bodyMesh != null && hair3Mesh != null)
        {
            forms.Add(new CharacterFormDto(
                "form_hair3",
                "변신 헤어 3",
                "Modular",
                "헤어 변형 3단계 파츠 전환",
                OverridePrimaryMeshPath: bodyMesh,
                EnableParts: [Path.GetFileName(hair3Mesh)]));
        }

        if (bodyMesh != null && tail2Mesh != null)
        {
            // e.g. Lupa: _Body + _Tail2
            forms.Add(new CharacterFormDto(
                "form_tail2",
                "해방 불꽃 꼬리 (_Tail2)",
                "Modular",
                "꼬리 변신 파츠 전환",
                OverridePrimaryMeshPath: bodyMesh,
                EnableParts: [Path.GetFileName(tail2Mesh)]));
        }

        // Fallback for standalone _Hair2/_Tail2 without a _Body split
        if (bodyMesh == null && hair2Mesh != null && !hair2Mesh.Equals(primary, StringComparison.OrdinalIgnoreCase))
        {
            forms.Add(new CharacterFormDto(
                "form_hair2",
                "변신 헤어 2",
                "Modular",
                "추가 헤어 파츠 활성화",
                EnableParts: [Path.GetFileName(hair2Mesh)]));
        }

        // 2. Material / texture swap forms detected from Model/ & Seq/ assets in this code folder
        var modelAndSeqNames = groupFiles
            .Where(f => f.Contains("/Model/", StringComparison.OrdinalIgnoreCase) || f.Contains("/Seq/", StringComparison.OrdinalIgnoreCase))
            .Select(f => Path.GetFileNameWithoutExtension(f))
            .ToList();

        bool HasTexOrMat(Func<string, bool> pred) =>
            modelAndSeqNames.Any(n => (n.StartsWith("MI_", StringComparison.OrdinalIgnoreCase) || n.StartsWith("T_", StringComparison.OrdinalIgnoreCase)) && pred(n));

        if (HasTexOrMat(n => n.Contains("Switch02", StringComparison.OrdinalIgnoreCase)))
        {
            forms.Add(new CharacterFormDto(
                "mat_Switch02",
                "변신 상태 2 (Switch02)",
                "Material",
                "전용 Switch02 머티리얼/텍스처 적용",
                MaterialPresetTag: "Switch02"));
        }
        if (HasTexOrMat(n => n.Contains("Switch03", StringComparison.OrdinalIgnoreCase)))
        {
            forms.Add(new CharacterFormDto(
                "mat_Switch03",
                "변신 상태 3 (Switch03)",
                "Material",
                "전용 Switch03 머티리얼/텍스처 적용",
                MaterialPresetTag: "Switch03"));
        }
        if (HasTexOrMat(n => (n.Contains("_Switch_", StringComparison.OrdinalIgnoreCase) || n.EndsWith("_Switch", StringComparison.OrdinalIgnoreCase))
                          && !n.Contains("Switch02", StringComparison.OrdinalIgnoreCase)
                          && !n.Contains("Switch03", StringComparison.OrdinalIgnoreCase)))
        {
            forms.Add(new CharacterFormDto(
                "mat_Switch",
                "상태 전환 (Switch)",
                "Material",
                "전용 Switch 머티리얼/텍스처 적용",
                MaterialPresetTag: "Switch"));
        }
        if (HasTexOrMat(n => n.Contains("_Change", StringComparison.OrdinalIgnoreCase)))
        {
            forms.Add(new CharacterFormDto(
                "mat_Change",
                "외형 변화 (Change)",
                "Material",
                "Change 머티리얼/텍스처 적용",
                MaterialPresetTag: "Change"));
        }
        if (HasTexOrMat(n => n.Contains("Damage", StringComparison.OrdinalIgnoreCase)))
        {
            forms.Add(new CharacterFormDto(
                "mat_Damage",
                "전투 손상 (Damage)",
                "Material",
                "손상 텍스처 적용",
                MaterialPresetTag: "Damage"));
        }
        // Alternate 02 textures/materials when matching 01 exists (e.g. TaiDaoNv Bangs02/Hair02/Up02/Down02/Face02/Eye02)
        bool has01Tex = HasTexOrMat(n => Regex.IsMatch(n, @"(Face|Hair|Bangs|Up|Down|Cloth|Eye)01(_D|_N|_ID)?$", RegexOptions.IgnoreCase));
        bool has02Tex = HasTexOrMat(n => Regex.IsMatch(n, @"(Face|Hair|Bangs|Up|Down|Cloth|Eye)02(_D|_N|_ID)?$", RegexOptions.IgnoreCase));
        if (has01Tex && has02Tex)
        {
            forms.Add(new CharacterFormDto(
                "mat_02",
                "변신 / 2페이즈 스킨 (02)",
                "Material",
                "01 파츠를 02 변신 텍스처/머티리얼로 전환",
                MaterialPresetTag: "02"));
        }
        bool has03Tex = HasTexOrMat(n => Regex.IsMatch(n, @"(Face|Hair|Bangs|Up|Down|Cloth|Eye|Skin)03(_D|_N|_ID)?$", RegexOptions.IgnoreCase));
        if (has03Tex)
        {
            forms.Add(new CharacterFormDto(
                "mat_03",
                "변신 스킨 (03)",
                "Material",
                "03 변신 텍스처/머티리얼로 전환",
                MaterialPresetTag: "03"));
        }
        if (HasTexOrMat(n => n.Contains("Seq02", StringComparison.OrdinalIgnoreCase)))
        {
            forms.Add(new CharacterFormDto(
                "mat_Seq02",
                "컷신/변신 (Seq02)",
                "Material",
                "Seq02 전용 머티리얼/텍스처 적용",
                MaterialPresetTag: "Seq02"));
        }
        if (HasTexOrMat(n => n.Contains("Seq04", StringComparison.OrdinalIgnoreCase)))
        {
            forms.Add(new CharacterFormDto(
                "mat_Seq04",
                "컷신/변신 (Seq04)",
                "Material",
                "Seq04 전용 머티리얼/텍스처 적용",
                MaterialPresetTag: "Seq04"));
        }

        // Only prepend Base form when at least one non-base form or modular split exists
        if (forms.Count > 0 || (hasExactCodeMesh && modelMeshes.Count > 1))
        {
            forms.Insert(0, new CharacterFormDto("base", "기본 폼", "Base", "기본 외형"));
        }

        return forms;
    }

    public List<AnimationItemDto> GetCharacterAnimations(string characterId, bool includeSharedBase = true)
    {
        if (!CharacterMap.TryGetValue(characterId, out var summary))
            return [];

        var prefix = $"Client/Content/Aki/Character/Role/{characterId}/";
        var siblingPrefix = $"Client/Content/Aki/Character/Role/{characterId}_";
        var charFiles = AllUAssets.Where(f =>
            f.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
            f.StartsWith(siblingPrefix, StringComparison.OrdinalIgnoreCase)).ToList();

        // Include Rover elemental animations if stored in sibling attribute folders
        if (summary.Name.Equals("Nvzhu", StringComparison.OrdinalIgnoreCase) ||
            summary.Name.Equals("Nanzhu", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var elem in new[] { "Dark", "Thunder", "Wind", "Light", "Ice", "Fire" })
            {
                var elemPrefix = $"Client/Content/Aki/Character/Role/{summary.BodyType}/{elem}{summary.Name}/";
                charFiles.AddRange(AllUAssets.Where(f => f.StartsWith(elemPrefix, StringComparison.OrdinalIgnoreCase)));
            }
        }

        var items = FindCharacterAnimationPaths(summary.BodyType, summary.Name, charFiles, includeSharedBase);
        return items;
    }

    private List<AnimationItemDto> FindCharacterAnimationPaths(string bodyType, string charName, List<string> charFiles, bool includeShared)
    {
        var candidatePaths = charFiles
            .Where(f => (f.Contains("Anim", StringComparison.OrdinalIgnoreCase) ||
                         f.Contains("Montage", StringComparison.OrdinalIgnoreCase))
                     && !f.Contains("/Physics/", StringComparison.OrdinalIgnoreCase))
            .Select(f => f[..^7])
            .ToList();

        // Map RibbonAnim/Rib_<Name> -> path for pairing
        var ribMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in candidatePaths)
        {
            var name = Path.GetFileName(p);
            if (name.StartsWith("Rib_", StringComparison.OrdinalIgnoreCase))
            {
                var baseKey = name[4..];
                ribMap.TryAdd(baseKey, p);
            }
        }

        var result = new List<AnimationItemDto>();
        var seenAnimPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in candidatePaths)
        {
            if (!seenAnimPaths.Add(p)) continue;
            var name = Path.GetFileName(p);
            if (name.StartsWith("ABP_", StringComparison.OrdinalIgnoreCase) ||
                name.StartsWith("BS_", StringComparison.OrdinalIgnoreCase) ||
                name.StartsWith("AO_", StringComparison.OrdinalIgnoreCase) ||
                name.StartsWith("Rib_", StringComparison.OrdinalIgnoreCase) ||
                name.EndsWith("_Skeleton", StringComparison.OrdinalIgnoreCase))
                continue;

            var isMontage = name.StartsWith("AM_", StringComparison.OrdinalIgnoreCase)
                         || p.Contains("Montage", StringComparison.OrdinalIgnoreCase);
            var cat = ClassifyAnimation(p, name);
            string? ribPath = null;
            if (ribMap.TryGetValue(name, out var r1)) ribPath = r1;
            else if (name.StartsWith("AM_", StringComparison.OrdinalIgnoreCase) && ribMap.TryGetValue(name[3..], out var r2)) ribPath = r2;

            result.Add(new AnimationItemDto(
                p,
                name,
                p,
                isMontage ? "Montage" : "Sequence",
                cat,
                0f,
                ribPath != null,
                ribPath,
                false));
        }

        // Also include Role/<BodyType>/BaseAnim* locomotion/common anims if requested
        if (includeShared && _sharedBaseAnims.TryGetValue(bodyType, out var shared))
        {
            foreach (var f in shared)
            {
                var p = f[..^7];
                if (!seenAnimPaths.Add(p)) continue;
                var name = Path.GetFileName(p);
                if (name.StartsWith("ABP_", StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith("BS_", StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith("AO_", StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith("Rib_", StringComparison.OrdinalIgnoreCase) ||
                    name.EndsWith("_Skeleton", StringComparison.OrdinalIgnoreCase))
                    continue;
                if (result.Any(r => r.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
                    continue;
                var isMontage = name.StartsWith("AM_", StringComparison.OrdinalIgnoreCase)
                             || p.Contains("Montage", StringComparison.OrdinalIgnoreCase);
                result.Add(new AnimationItemDto(
                    p, name, p,
                    isMontage ? "Montage" : "Sequence",
                    ClassifyAnimation(p, name),
                    0f,
                    ribMap.TryGetValue(name, out var rp),
                    rp,
                    true));
            }
        }

        // Also add standalone sequence/facial animations under Sequence/SequenceAnim/<CharName> if present
        var seqAnimMatches = AllUAssets
            .Where(f => f.Contains("SequenceAnim", StringComparison.OrdinalIgnoreCase)
                     && f.Contains(charName, StringComparison.OrdinalIgnoreCase)
                     && !f.Contains("/AO/", StringComparison.OrdinalIgnoreCase))
            .Take(80);
        foreach (var f in seqAnimMatches)
        {
            var p = f[..^7];
            if (!seenAnimPaths.Add(p)) continue;
            var name = Path.GetFileName(p);
            result.Add(new AnimationItemDto(p, name, p, "Sequence", "Cutscene", 0f, false, null, false));
        }

        return result
            .OrderBy(a => CategoryOrder(a.Category))
            .ThenBy(a => a.IsSharedBase ? 1 : 0)
            .ThenBy(a => a.Name)
            .ToList();
    }

    private static string ClassifyAnimation(string path, string name)
    {
        if (name.Contains("Burst", StringComparison.OrdinalIgnoreCase) || name.Contains("Ult", StringComparison.OrdinalIgnoreCase)) return "Burst";
        if (name.Contains("Skill", StringComparison.OrdinalIgnoreCase) || name.Contains("Qte", StringComparison.OrdinalIgnoreCase) || name.Contains("Execute", StringComparison.OrdinalIgnoreCase)) return "Skill";
        if (name.Contains("Attack", StringComparison.OrdinalIgnoreCase) || name.Contains("Counter", StringComparison.OrdinalIgnoreCase) || name.Contains("Heavy", StringComparison.OrdinalIgnoreCase)) return "Attack";
        if (name.StartsWith("Ui", StringComparison.OrdinalIgnoreCase) || name.Contains("Gacha", StringComparison.OrdinalIgnoreCase) || name.Contains("DrawCard", StringComparison.OrdinalIgnoreCase) || path.Contains("UiAnim", StringComparison.OrdinalIgnoreCase)) return "UI";
        if (path.Contains("SequenceAnim", StringComparison.OrdinalIgnoreCase)) return "Cutscene";
        if (name.Contains("Walk", StringComparison.OrdinalIgnoreCase) || name.Contains("Run", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Stand", StringComparison.OrdinalIgnoreCase) || name.Contains("Jump", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Climb", StringComparison.OrdinalIgnoreCase) || name.Contains("Swim", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Sprint", StringComparison.OrdinalIgnoreCase) || name.Contains("Land", StringComparison.OrdinalIgnoreCase)) return "Movement";
        return "Other";
    }

    private static int CategoryOrder(string cat) => cat switch
    {
        "Attack" => 0,
        "Skill" => 1,
        "Burst" => 2,
        "UI" => 3,
        "Movement" => 4,
        "Cutscene" => 5,
        _ => 6
    };

    public string GetCacheFilePath(string category, string key, string ext)
    {
        var safe = NonFileNameRegex().Replace(key, "_");
        if (safe.Length > 140)
        {
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(key)))[..12];
            safe = safe[^80..] + "_" + hash;
        }
        var dir = Path.Combine(CacheDir, category);
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, $"{safe}.{ext}");
    }

    public void Dispose()
    {
        Provider?.Dispose();
    }

    private void EnsureNativeBinaryInAppDir(string fileName)
    {
        var dest = Path.Combine(AppContext.BaseDirectory, fileName);
        if (File.Exists(dest))
            return;

        var candidate = Path.Combine(_env.ContentRootPath, "native", fileName);
        if (File.Exists(candidate))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(candidate, dest, overwrite: false);
        }
    }

    private static string ResolveCacheDir(string configured, string contentRootPath)
    {
        var raw = Environment.ExpandEnvironmentVariables(configured ?? string.Empty).Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(raw))
            raw = "cache";

        if (Path.IsPathRooted(raw))
            return Path.GetFullPath(raw);

        var envCache = Environment.GetEnvironmentVariable("WUWA_CACHE_DIR");
        if (!string.IsNullOrWhiteSpace(envCache))
        {
            var envBase = Environment.GetEnvironmentVariable("WUWA_DOTENV_DIR");
            var baseDir = !string.IsNullOrWhiteSpace(envBase) ? envBase : Directory.GetCurrentDirectory();
            return Path.GetFullPath(raw, baseDir);
        }

        return Path.GetFullPath(raw, AppContext.BaseDirectory);
    }

    private static string ResolveKeysPath(string configured, string contentRootPath)
    {
        var raw = Environment.ExpandEnvironmentVariables(configured ?? string.Empty).Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(raw))
            raw = Path.Combine("wuwa-keys", "keys.json");

        if (Path.IsPathRooted(raw))
            return Path.GetFullPath(raw);

        var normalizedRel = raw.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
        var relVariants = new List<string> { normalizedRel };
        var trimmedParentPrefix = normalizedRel;
        var parentToken = ".." + Path.DirectorySeparatorChar;
        while (trimmedParentPrefix.StartsWith(parentToken, StringComparison.Ordinal))
            trimmedParentPrefix = trimmedParentPrefix[parentToken.Length..];
        if (!string.IsNullOrEmpty(trimmedParentPrefix) && trimmedParentPrefix != normalizedRel)
            relVariants.Add(trimmedParentPrefix);

        var searchRoots = new List<string>();
        void AddAncestors(string? start)
        {
            if (string.IsNullOrWhiteSpace(start)) return;
            var dir = new DirectoryInfo(start);
            for (var i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
                searchRoots.Add(dir.FullName);
        }

        AddAncestors(Environment.GetEnvironmentVariable("WUWA_DOTENV_DIR"));
        AddAncestors(Directory.GetCurrentDirectory());
        AddAncestors(contentRootPath);
        AddAncestors(AppContext.BaseDirectory);

        foreach (var root in searchRoots.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            foreach (var rel in relVariants)
            {
                var candidate = Path.GetFullPath(rel, root);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        var fallbackBase = Environment.GetEnvironmentVariable("WUWA_DOTENV_DIR") ?? contentRootPath;
        return Path.GetFullPath(normalizedRel, fallbackBase);
    }

    [GeneratedRegex(@"[^a-zA-Z0-9_\-\.]")]
    private static partial Regex NonFileNameRegex();

    private sealed record KeyEntry(string guid, string key);
    private sealed record KeyFile(string mainKey, List<KeyEntry> dynamicKeys);
}
