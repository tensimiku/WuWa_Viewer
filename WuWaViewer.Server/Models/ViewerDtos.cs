namespace WuWaViewer.Server.Models;

public sealed class ViewerOptions
{
    public string GameDir { get; set; } = string.Empty;
    public string KeysPath { get; set; } = @"wuwa-keys\keys.json";
    public string CacheDir { get; set; } = "cache";
}

public sealed record CharacterPartDto(
    string ComponentName,
    string MeshPath,
    string? AttachParent,
    string? AttachSocket,
    float[]? RelativePosition,
    float[]? RelativeQuaternion,
    float[]? RelativeScale,
    bool DefaultVisible = true,
    string? PartKind = null,
    Dictionary<int, MaterialSlotDto>? OverrideMaterials = null
);

public sealed record CharacterLinkedFormDto(
    string CharacterId,
    string Name,
    string Relationship
);

public sealed record CharacterFormDto(
    string Id,
    string Name,
    string Kind,
    string? Description = null,
    string? OverridePrimaryMeshPath = null,
    List<string>? EnableParts = null,
    List<string>? DisableParts = null,
    string? MaterialPresetTag = null,
    Dictionary<string, float>? MorphOverrides = null,
    string? LinkedCharacterId = null
);

public sealed record WeaponSummaryDto(
    string Id,
    string Name,
    string MeshPath,
    string Category
);

public sealed record CharacterVariantDto(
    string Id,
    string Name,
    string PrimaryMeshPath,
    List<CharacterPartDto> ExtraParts,
    string? DefaultAbpPath,
    List<CharacterFormDto>? Forms = null,
    List<CharacterLinkedFormDto>? LinkedForms = null
);

public sealed record CharacterSummaryDto(
    string Id,
    string Name,
    string BodyType,
    List<CharacterVariantDto> Variants,
    List<WeaponSummaryDto> SuggestedWeapons,
    bool HasPhysics,
    int AnimCount,
    int CutsceneCount
);

public sealed record MaterialSlotDto(
    int Index,
    string Name,
    string AssetPath,
    string? ParentName,
    string ShaderType,
    bool TwoSided,
    string BlendMode,
    Dictionary<string, float> Scalars,
    Dictionary<string, float[]> Vectors,
    Dictionary<string, bool> Switches,
    Dictionary<string, string> Textures
);

public sealed record MeshSectionDto(
    int SectionIndex,
    int MaterialIndex,
    string MaterialName,
    int NumTriangles,
    bool Disabled,
    bool CastShadow,
    int? OutlineMaterialIndex,
    int? FaceShadowMaterialIndex,
    int? HetaMaterialIndex
);

public sealed record SocketDto(
    string Name,
    string BoneName,
    float[] Position,
    float[] Quaternion,
    float[] Scale
);

public sealed record ModelManifestDto(
    string MeshPath,
    string MeshName,
    string MeshType,
    string? SkeletonName,
    string? SkeletonPath,
    string GlbUrl,
    List<MaterialSlotDto> Materials,
    List<MeshSectionDto> Sections,
    List<SocketDto> Sockets,
    List<string> MorphTargets
);

public sealed record ModelMaterialPresetDto(
    string Tag,
    string Name,
    Dictionary<string, MaterialSlotDto> SlotOverrides
);

public sealed record ModelFormMaterialsDto(
    string MeshPath,
    List<ModelMaterialPresetDto> Presets
);

public sealed record AnimationItemDto(
    string Id,
    string Name,
    string Path,
    string Kind,
    string Category,
    float Duration,
    bool HasRibbonLayer,
    string? RibbonPath,
    bool IsSharedBase
);

public sealed record AnimBoneTrackDto(
    string BoneName,
    string TranslationMode,
    bool HasExplicitTrack,
    float[] PosKeys,
    float[] QuatKeys,
    float[] ScaleKeys
);

public sealed record AnimFloatCurveDto(
    string Name,
    float[] Times,
    float[] Values
);

public sealed record AnimSegmentPayloadDto(
    string Name,
    string SlotName,
    float StartTime,
    float EndTime,
    float PlayRate,
    int LoopingCount,
    float SourceLength,
    float FrameRate,
    int NumFrames,
    bool IsAdditive,
    bool HasRefPoseSeq,
    List<AnimBoneTrackDto> Tracks,
    List<AnimFloatCurveDto> Curves
);

public sealed record AnimationPayloadDto(
    string Path,
    string Name,
    string Kind,
    float Duration,
    string? SkeletonName,
    List<AnimSegmentPayloadDto> Segments,
    AnimationPayloadDto? RibbonLayer
);

public sealed record KawaiiCurveSampleDto(
    bool Enabled,
    float[] Times,
    float[] Values
);

public sealed record KawaiiSettingsDto(
    float Damping,
    float WorldDampingLocation,
    float WorldDampingRotation,
    float Stiffness,
    float Radius,
    float LimitAngle,
    float HalfWidth,
    string Shape
);

public sealed record KawaiiCapsuleLimitDto(
    string DrivingBone,
    float[] OffsetLocation,
    float[] OffsetQuaternion,
    float Radius,
    float Length
);

public sealed record KawaiiSphereLimitDto(
    string DrivingBone,
    float[] OffsetLocation,
    float Radius,
    string LimitType
);

public sealed record KawaiiPlanarLimitDto(
    string DrivingBone,
    float[] OffsetLocation,
    float[] PlaneNormal
);

public sealed record KawaiiGroupDto(
    string Name,
    List<string> RootBones,
    List<string> ExcludeBones,
    float DummyBoneLength,
    string BoneForwardAxis,
    string PlanarConstraint,
    KawaiiSettingsDto Settings,
    float[] Gravity,
    float GravityScale,
    bool EnableWind,
    float WindScale,
    float Alpha,
    KawaiiCurveSampleDto? DampingCurve,
    KawaiiCurveSampleDto? StiffnessCurve,
    KawaiiCurveSampleDto? RadiusCurve,
    KawaiiCurveSampleDto? LimitAngleCurve,
    List<KawaiiCapsuleLimitDto> CapsuleLimits,
    List<KawaiiSphereLimitDto> SphericalLimits,
    List<KawaiiPlanarLimitDto> PlanarLimits
);

public sealed record PhysicsConfigDto(
    string CharacterId,
    string SourceAbp,
    List<KawaiiGroupDto> Groups
);

public sealed record CutsceneSummaryDto(
    string Id,
    string Name,
    string Path,
    string Category,
    string? CharacterHint
);

public sealed record CutsceneFloatChannelDto(
    float DefaultValue,
    float[] Times,
    float[] Values
);

public sealed record CutsceneTransformTrackDto(
    float StartTime,
    float EndTime,
    CutsceneFloatChannelDto Tx,
    CutsceneFloatChannelDto Ty,
    CutsceneFloatChannelDto Tz,
    CutsceneFloatChannelDto Rx,
    CutsceneFloatChannelDto Ry,
    CutsceneFloatChannelDto Rz,
    CutsceneFloatChannelDto Sx,
    CutsceneFloatChannelDto Sy,
    CutsceneFloatChannelDto Sz
);

public sealed record CutsceneAnimSectionDto(
    float StartTime,
    float EndTime,
    string AnimPath,
    string AnimName,
    float PlayRate,
    bool Loop,
    float FirstLoopStartOffset,
    float StartFrameOffset
);

public sealed record CutsceneActorDto(
    string Guid,
    string Name,
    string? MeshPath,
    string? CharacterIdHint,
    string? VariantIdHint,
    bool IsCamera,
    List<CutsceneAnimSectionDto> AnimSections,
    List<CutsceneTransformTrackDto> TransformTracks,
    List<CutsceneFloatChannelDto> CameraFovTracks
);

public sealed record CutsceneCameraCutDto(
    float StartTime,
    float EndTime,
    string CameraGuid
);

public sealed record CutsceneDetailDto(
    string Path,
    string Name,
    float Duration,
    float DisplayRate,
    float TickResolution,
    List<CutsceneActorDto> Actors,
    List<CutsceneCameraCutDto> CameraCuts
);

public sealed record RbfCurveKeyDto(
    float Time,
    float Value
);

public sealed record RbfWeightModifierDto(
    string SrcWeight,
    int DstDriverIndex,
    string DstWeight,
    RbfCurveKeyDto[] FactorCurve
);

public sealed record RbfPoseTargetDto(
    float[] DriverValues,
    Dictionary<string, float> DrivenWeights
);

public sealed record RbfPrecomputationTableDto(
    float RotationLimitX,
    float RotationLimitY,
    float RotationLimitZ,
    float Interval,
    int CountY,
    int CountZ,
    float[][] Weights
);

public sealed record SkeletonRbfDriverDto(
    int Index,
    string DriverName,
    string DriverBoneName,
    string BaseBoneName,
    string? BaseParentBoneName,
    float[] BaseCompRestPosCm,
    float[] BaseCompRestQuat,
    float[] DriverCompRestPosCm,
    float RestRadiusCm,
    string[] DriverAttributes,
    string[] DrivenMorphTargets,
    RbfWeightModifierDto? WeightModifier,
    List<RbfPoseTargetDto> DriveSettings,
    RbfPrecomputationTableDto? Precomputation
);

public sealed record PoseAssetBoneDeltaDto(
    string BoneName,
    float[] DeltaTranslationCm,
    float[] DeltaRotationQuat
);

public sealed record PoseDriverPoseDto(
    string PoseName,
    float[] TargetRotationPitchYawRoll,
    float[] TargetRotationQuat,
    float TargetScale,
    bool IsHidden,
    List<PoseAssetBoneDeltaDto> DrivenBones
);

public sealed record PoseDriverNodeDto(
    string NodeName,
    string SourceBone,
    string? SourceParentBone,
    float[] SourceCompRestQuat,
    float[] SourceLocalRestQuat,
    List<string> OnlyDriveBones,
    string SolverType,
    string FunctionType,
    string DistanceMethod,
    float Radius,
    bool AutomaticRadius,
    float WeightThreshold,
    string NormalizeMethod,
    string PoseAssetPath,
    bool AdditivePose,
    Dictionary<string, float[]> BoneLocalRestQuats,
    Dictionary<string, float[]> BoneCompRestQuats,
    Dictionary<string, float[]> BoneParentCompRestQuats,
    List<PoseDriverPoseDto> Poses
);

public sealed record RigRbfConfigDto(
    string SkeletonPath,
    string? MeshPath,
    string? CharacterId,
    string? PrecomputationPath,
    string? SourceAbp,
    List<SkeletonRbfDriverDto> RbfDrivers,
    List<PoseDriverNodeDto> PoseDrivers
);
