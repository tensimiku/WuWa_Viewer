using Microsoft.AspNetCore.ResponseCompression;
using WuWaViewer.Server.Models;
using WuWaViewer.Server.Services;

var dotEnvDir = LoadDotEnv(Directory.GetCurrentDirectory(), AppContext.BaseDirectory);

var builder = WebApplication.CreateBuilder(args);

builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

var envOverrides = new Dictionary<string, string?>();
void MapEnv(string envName, string configKey)
{
    var val = Environment.GetEnvironmentVariable(envName);
    if (!string.IsNullOrWhiteSpace(val))
        envOverrides[configKey] = val.Trim().Trim('"');
}

MapEnv("WUWA_GAME_DIR", "WuWaViewer:GameDir");
MapEnv("WUWA_KEYS_PATH", "WuWaViewer:KeysPath");
MapEnv("WUWA_CACHE_DIR", "WuWaViewer:CacheDir");
if (envOverrides.Count > 0)
    builder.Configuration.AddInMemoryCollection(envOverrides);

builder.Services.Configure<ViewerOptions>(builder.Configuration.GetSection("WuWaViewer"));
builder.Services.AddSingleton<GameAssetService>();
builder.Services.AddSingleton<ModelService>();
builder.Services.AddSingleton<AnimationService>();
builder.Services.AddSingleton<PhysicsService>();
builder.Services.AddSingleton<RbfService>();
builder.Services.AddSingleton<CutsceneService>();

builder.Services.AddResponseCompression(opts =>
{
    opts.EnableForHttps = true;
    opts.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(["model/gltf-binary", "application/json"]);
});

builder.Services.AddCors(opts =>
{
    opts.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());
});

var app = builder.Build();
app.UseCors();
app.UseResponseCompression();

// Initialize CUE4Parse & Asset Indices on startup
var assets = app.Services.GetRequiredService<GameAssetService>();
await assets.InitializeAsync();

app.MapGet("/api/health", () => Results.Ok(new
{
    ok = true,
    mountedVfs = assets.Provider.MountedVfs.Count,
    totalFiles = assets.Provider.Files.Count,
    characters = assets.Characters.Count,
    weapons = assets.Weapons.Count,
    cutscenes = assets.Cutscenes.Count
}));

app.MapGet("/api/characters", () => Results.Ok(assets.Characters));

app.MapGet("/api/characters/{*id}", (string id, ModelService models) =>
{
    if (!assets.CharacterMap.TryGetValue(id, out var summary))
        return Results.NotFound(new { error = $"Character not found: {id}" });

    var enrichedVariants = summary.Variants.Select(v =>
    {
        var merged = v.ExtraParts.ToList();
        var resolved = models.ResolveBlueprintParts(id, v.Id);
        foreach (var bp in resolved)
        {
            if (bp.MeshPath.Equals(v.PrimaryMeshPath, StringComparison.OrdinalIgnoreCase))
                continue;

            var existingIdx = merged.FindIndex(m => m.MeshPath.Equals(bp.MeshPath, StringComparison.OrdinalIgnoreCase));
            if (existingIdx >= 0)
            {
                var ex = merged[existingIdx];
                merged[existingIdx] = ex with
                {
                    AttachParent = ex.AttachParent ?? bp.AttachParent,
                    AttachSocket = ex.AttachSocket ?? bp.AttachSocket,
                    RelativePosition = ex.RelativePosition ?? bp.RelativePosition,
                    RelativeQuaternion = ex.RelativeQuaternion ?? bp.RelativeQuaternion,
                    RelativeScale = ex.RelativeScale ?? bp.RelativeScale,
                    OverrideMaterials = ex.OverrideMaterials ?? bp.OverrideMaterials,
                };
            }
            else
            {
                merged.Add(bp);
            }
        }

        var forms = v.Forms?.ToList() ?? [];
        var propParts = merged.Where(p => p.PartKind == "Prop" && !p.DefaultVisible).ToList();

        if (summary.Name.Equals("Nvzhu", StringComparison.OrdinalIgnoreCase) ||
            summary.Name.Equals("Nanzhu", StringComparison.OrdinalIgnoreCase))
        {
            var darkProps = propParts.Where(p => p.ComponentName.Contains("Dark", StringComparison.OrdinalIgnoreCase) || p.MeshPath.Contains("Dark", StringComparison.OrdinalIgnoreCase)).Select(p => p.ComponentName).ToList();
            var thunderProps = propParts.Where(p => p.ComponentName.Contains("Thunder", StringComparison.OrdinalIgnoreCase) || p.MeshPath.Contains("Leizhu", StringComparison.OrdinalIgnoreCase) || p.MeshPath.Contains("Thunder", StringComparison.OrdinalIgnoreCase)).Select(p => p.ComponentName).ToList();
            var windProps = propParts.Where(p => p.ComponentName.Contains("Wind", StringComparison.OrdinalIgnoreCase) || p.MeshPath.Contains("Wind", StringComparison.OrdinalIgnoreCase)).Select(p => p.ComponentName).ToList();

            if (darkProps.Count > 0)
                forms.Add(new CharacterFormDto("prop_dark", "인멸 (Havoc) 방랑자", "Prop", "인멸 속성 날개/전투 소품", EnableParts: darkProps));
            if (thunderProps.Count > 0)
                forms.Add(new CharacterFormDto("prop_thunder", "전도 (Electro) 방랑자", "Prop", "전도 속성 방패/무장 소품", EnableParts: thunderProps));
            if (windProps.Count > 0)
                forms.Add(new CharacterFormDto("prop_wind", "기류 (Aero) 방랑자", "Prop", "기류 속성 공명 안광/무장", EnableParts: windProps));
        }
        else if (propParts.Count > 0)
        {
            // Enrich Lupa's flame tail form with matching L/R fire parts if available
            var fireProps = propParts.Where(p => p.MeshPath.Contains("Fire", StringComparison.OrdinalIgnoreCase) || p.ComponentName.Contains("Fire", StringComparison.OrdinalIgnoreCase)).Select(p => p.ComponentName).ToList();
            if (fireProps.Count > 0)
            {
                var tailIdx = forms.FindIndex(f => f.Id == "form_tail2");
                if (tailIdx >= 0)
                {
                    var tf = forms[tailIdx];
                    var combined = (tf.EnableParts ?? []).Concat(fireProps).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                    forms[tailIdx] = tf with { Name = "해방 불꽃 꼬리 + 화염", EnableParts = combined };
                }
            }

            string propFormName = summary.Name switch
            {
                "Jinxi" => "용각 개방 (Dragon Horn)",
                "Zanni" => "선글라스 / 보조 소품",
                "Jiabeilina" => "악마 날개 / 키메라",
                "Aogusita" => "태양관 / 공명 소품",
                "Shouanren" => "해방 나비 (Butterfly)",
                "Chun" => "덩굴 / 개화 소품",
                "Mone" => "판넬 / 호버시트",
                "Lingyang" => "사자탈 / 사자춤 폼",
                _ => "변신 / 전용 전투 소품"
            };
            forms.Add(new CharacterFormDto("prop_all", propFormName, "Prop", "전용 변신·전투 부착 소품 활성화",
                EnableParts: propParts.Select(p => p.ComponentName).ToList()));
        }

        if (forms.Count > 0 && forms[0].Id != "base")
            forms.Insert(0, new CharacterFormDto("base", "기본 폼", "Base", "기본 외형"));

        return v with
        {
            ExtraParts = merged,
            Forms = forms.Count > 0 ? forms : null
        };
    }).ToList();

    return Results.Ok(summary with { Variants = enrichedVariants });
});

app.MapGet("/api/weapons", (string? q, int limit = 100) =>
{
    IEnumerable<WeaponSummaryDto> list = assets.Weapons;
    if (!string.IsNullOrWhiteSpace(q))
        list = list.Where(w => w.Name.Contains(q, StringComparison.OrdinalIgnoreCase) || w.Category.Contains(q, StringComparison.OrdinalIgnoreCase));
    return Results.Ok(list.Take(Math.Clamp(limit, 1, 500)));
});

app.MapGet("/api/model/manifest", async (string path, ModelService models) =>
{
    var manifest = await models.GetModelManifestAsync(path);
    return manifest != null ? Results.Ok(manifest) : Results.NotFound(new { error = $"Mesh not found: {path}" });
});

app.MapGet("/api/model/form-materials", async (string path, ModelService models) =>
{
    var res = await models.ResolveFormMaterialsAsync(path);
    return res != null ? Results.Ok(res) : Results.NotFound(new { error = $"Mesh not found: {path}" });
});

app.MapGet("/api/model/glb", async (string path, ModelService models) =>
{
    var bytes = await models.GetGlbBytesAsync(path);
    return bytes != null ? Results.File(bytes, "model/gltf-binary") : Results.NotFound();
});

app.MapGet("/api/texture", async (string path, ModelService models) =>
{
    var bytes = await models.GetTexturePngAsync(path);
    return bytes != null ? Results.File(bytes, "image/png") : Results.NotFound();
});

app.MapGet("/api/animations", (string characterId, bool includeShared = true) =>
{
    return Results.Ok(assets.GetCharacterAnimations(characterId, includeShared));
});

app.MapGet("/api/animation", async (string path, string? ribbonPath, AnimationService animSvc) =>
{
    var payload = await animSvc.GetAnimationAsync(path, ribbonPath);
    return payload != null ? Results.Ok(payload) : Results.NotFound(new { error = $"Animation not found or unreadable: {path}" });
});

app.MapGet("/api/physics", (string characterId, string? abp, PhysicsService physSvc) =>
{
    var cfg = physSvc.GetCharacterPhysics(characterId, abp);
    return cfg != null ? Results.Ok(cfg) : Results.Ok(new PhysicsConfigDto(characterId, "", []));
});

app.MapGet("/api/rig/rbf", async (
    string? meshPath,
    string? skeletonPath,
    string? characterId,
    string? abp,
    RbfService rbfSvc) =>
{
    if (string.IsNullOrWhiteSpace(meshPath) && string.IsNullOrWhiteSpace(skeletonPath) && string.IsNullOrWhiteSpace(characterId))
        return Results.BadRequest(new { error = "Provide meshPath, skeletonPath, or characterId." });

    var cfg = await rbfSvc.GetRigRbfConfigAsync(meshPath, skeletonPath, characterId, abp);
    return cfg != null
        ? Results.Ok(cfg)
        : Results.NotFound(new { error = "No matching skeleton or RBF data found." });
});

app.MapGet("/api/cutscenes", (string? character, string? category, string? q, int limit = 120) =>
{
    IEnumerable<CutsceneSummaryDto> list = assets.Cutscenes;
    if (!string.IsNullOrWhiteSpace(character))
    {
        var name = character.Contains('/') ? character.Split('/').Last() : character;
        list = list.Where(c => c.Path.Contains(name, StringComparison.OrdinalIgnoreCase));
    }
    if (!string.IsNullOrWhiteSpace(category))
        list = list.Where(c => c.Category.Equals(category, StringComparison.OrdinalIgnoreCase));
    if (!string.IsNullOrWhiteSpace(q))
        list = list.Where(c => c.Name.Contains(q, StringComparison.OrdinalIgnoreCase) || c.Path.Contains(q, StringComparison.OrdinalIgnoreCase));

    return Results.Ok(list.Take(Math.Clamp(limit, 1, 500)));
});

app.MapGet("/api/cutscene", (string path, CutsceneService csSvc) =>
{
    var detail = csSvc.GetCutsceneDetail(path);
    return detail != null ? Results.Ok(detail) : Results.NotFound(new { error = $"Cutscene not found: {path}" });
});

var explicitUrls = builder.Configuration[WebHostDefaults.ServerUrlsKey];
var apiUrl = !string.IsNullOrWhiteSpace(explicitUrls)
    ? null
    : Environment.GetEnvironmentVariable("WUWA_API_URL")?.Trim();

if (string.IsNullOrWhiteSpace(explicitUrls))
    app.Run(string.IsNullOrWhiteSpace(apiUrl) ? "http://localhost:5180" : apiUrl);
else
    app.Run();

static string? LoadDotEnv(params string[] startDirs)
{
    foreach (var start in startDirs)
    {
        var dir = new DirectoryInfo(start);
        for (var i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
        {
            var envFile = Path.Combine(dir.FullName, ".env");
            if (!File.Exists(envFile)) continue;

            foreach (var rawLine in File.ReadAllLines(envFile))
            {
                var line = rawLine.Trim();
                if (line.Length == 0 || line.StartsWith('#')) continue;
                if (line.StartsWith("export ", StringComparison.Ordinal))
                    line = line[7..].TrimStart();

                var eq = line.IndexOf('=');
                if (eq <= 0) continue;

                var key = line[..eq].Trim();
                var val = line[(eq + 1)..].Trim();
                if ((val.StartsWith('"') && val.EndsWith('"') && val.Length >= 2) ||
                    (val.StartsWith('\'') && val.EndsWith('\'') && val.Length >= 2))
                {
                    val = val[1..^1];
                }

                if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
                    Environment.SetEnvironmentVariable(key, val);
            }

            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WUWA_DOTENV_DIR")))
                Environment.SetEnvironmentVariable("WUWA_DOTENV_DIR", dir.FullName);

            return dir.FullName;
        }
    }

    return null;
}

