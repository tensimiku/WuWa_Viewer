export interface CharacterPartDto {
  componentName: string;
  meshPath: string;
  attachParent: string | null;
  attachSocket: string | null;
  relativePosition: number[] | null;
  relativeQuaternion: number[] | null;
  relativeScale: number[] | null;
  defaultVisible?: boolean;
  partKind?: 'Modular' | 'Prop' | 'WeaponProp' | string | null;
  overrideMaterials?: Record<number, MaterialSlotDto> | null;
}

export interface WeaponSummaryDto {
  id: string;
  name: string;
  meshPath: string;
  category: string;
}

export interface CharacterLinkedFormDto {
  characterId: string;
  name: string;
  relationship: string;
}

export interface CharacterFormDto {
  id: string;
  name: string;
  kind: 'Base' | 'Modular' | 'Prop' | 'Material' | 'LinkedCharacter' | string;
  description?: string | null;
  overridePrimaryMeshPath?: string | null;
  enableParts?: string[] | null;
  disableParts?: string[] | null;
  materialPresetTag?: string | null;
  morphOverrides?: Record<string, number> | null;
  linkedCharacterId?: string | null;
}

export interface CharacterVariantDto {
  id: string;
  name: string;
  primaryMeshPath: string;
  extraParts: CharacterPartDto[];
  defaultAbpPath: string | null;
  forms?: CharacterFormDto[] | null;
  linkedForms?: CharacterLinkedFormDto[] | null;
}

export interface ModelMaterialPresetDto {
  tag: string;
  name: string;
  slotOverrides: Record<string, MaterialSlotDto>;
}

export interface ModelFormMaterialsDto {
  meshPath: string;
  presets: ModelMaterialPresetDto[];
}

export interface CharacterSummaryDto {
  id: string;
  name: string;
  bodyType: string;
  variants: CharacterVariantDto[];
  suggestedWeapons: WeaponSummaryDto[];
  hasPhysics: boolean;
  animCount: number;
  cutsceneCount: number;
}

export interface MaterialSlotDto {
  index: number;
  name: string;
  assetPath: string;
  parentName: string | null;
  shaderType: 'Body' | 'Face' | 'Eye' | 'Hair' | 'Outline' | 'FaceShadow' | 'HETA' | 'Distortion' | 'Standard';
  twoSided: boolean;
  blendMode: string;
  scalars: Record<string, number>;
  vectors: Record<string, number[]>;
  switches: Record<string, boolean>;
  textures: Record<string, string>;
}

export interface MeshSectionDto {
  sectionIndex: number;
  materialIndex: number;
  materialName: string;
  numTriangles: number;
  disabled: boolean;
  castShadow: boolean;
  outlineMaterialIndex: number | null;
  faceShadowMaterialIndex: number | null;
  hetaMaterialIndex: number | null;
}

export interface SocketDto {
  name: string;
  boneName: string;
  position: number[];
  quaternion: number[];
  scale: number[];
}

export interface ModelManifestDto {
  meshPath: string;
  meshName: string;
  meshType: string;
  skeletonName: string | null;
  skeletonPath: string | null;
  glbUrl: string;
  materials: MaterialSlotDto[];
  sections: MeshSectionDto[];
  sockets: SocketDto[];
  morphTargets: string[];
}

export interface AnimationItemDto {
  id: string;
  name: string;
  path: string;
  kind: 'Sequence' | 'Montage';
  category: string;
  duration: number;
  hasRibbonLayer: boolean;
  ribbonPath: string | null;
  isSharedBase: boolean;
}

export interface AnimBoneTrackDto {
  boneName: string;
  translationMode: string;
  hasExplicitTrack: boolean;
  posKeys: number[];
  quatKeys: number[];
  scaleKeys: number[];
}

export interface AnimFloatCurveDto {
  name: string;
  times: number[];
  values: number[];
}

export interface AnimSegmentPayloadDto {
  name: string;
  slotName: string;
  startTime: number;
  endTime: number;
  playRate: number;
  loopingCount: number;
  sourceLength: number;
  frameRate: number;
  numFrames: number;
  isAdditive: boolean;
  hasRefPoseSeq: boolean;
  tracks: AnimBoneTrackDto[];
  curves: AnimFloatCurveDto[];
}

export interface AnimationPayloadDto {
  path: string;
  name: string;
  kind: 'Sequence' | 'Montage';
  duration: number;
  skeletonName: string | null;
  segments: AnimSegmentPayloadDto[];
  ribbonLayer: AnimationPayloadDto | null;
}

export interface KawaiiCurveSampleDto {
  enabled: boolean;
  times: number[];
  values: number[];
}

export interface KawaiiSettingsDto {
  damping: number;
  worldDampingLocation: number;
  worldDampingRotation: number;
  stiffness: number;
  radius: number;
  limitAngle: number;
  halfWidth: number;
  shape: string;
}

export interface KawaiiCapsuleLimitDto {
  drivingBone: string;
  offsetLocation: number[];
  offsetQuaternion: number[];
  radius: number;
  length: number;
}

export interface KawaiiSphereLimitDto {
  drivingBone: string;
  offsetLocation: number[];
  radius: number;
  limitType: string;
}

export interface KawaiiPlanarLimitDto {
  drivingBone: string;
  offsetLocation: number[];
  planeNormal: number[];
}

export interface KawaiiGroupDto {
  name: string;
  rootBones: string[];
  excludeBones: string[];
  dummyBoneLength: number;
  boneForwardAxis: string;
  planarConstraint: string;
  settings: KawaiiSettingsDto;
  gravity: number[];
  gravityScale: number;
  enableWind: boolean;
  windScale: number;
  alpha: number;
  dampingCurve: KawaiiCurveSampleDto | null;
  stiffnessCurve: KawaiiCurveSampleDto | null;
  radiusCurve: KawaiiCurveSampleDto | null;
  limitAngleCurve: KawaiiCurveSampleDto | null;
  capsuleLimits: KawaiiCapsuleLimitDto[];
  sphericalLimits: KawaiiSphereLimitDto[];
  planarLimits: KawaiiPlanarLimitDto[];
}

export interface PhysicsConfigDto {
  characterId: string;
  sourceAbp: string;
  groups: KawaiiGroupDto[];
}

export interface CutsceneSummaryDto {
  id: string;
  name: string;
  path: string;
  category: string;
  characterHint: string | null;
}

export interface CutsceneFloatChannelDto {
  defaultValue: number;
  times: number[];
  values: number[];
}

export interface CutsceneTransformTrackDto {
  startTime: number;
  endTime: number;
  tx: CutsceneFloatChannelDto;
  ty: CutsceneFloatChannelDto;
  tz: CutsceneFloatChannelDto;
  rx: CutsceneFloatChannelDto;
  ry: CutsceneFloatChannelDto;
  rz: CutsceneFloatChannelDto;
  sx: CutsceneFloatChannelDto;
  sy: CutsceneFloatChannelDto;
  sz: CutsceneFloatChannelDto;
}

export interface CutsceneAnimSectionDto {
  startTime: number;
  endTime: number;
  animPath: string;
  animName: string;
  playRate: number;
  loop: boolean;
  firstLoopStartOffset: number;
  startFrameOffset: number;
}

export interface CutsceneActorDto {
  guid: string;
  name: string;
  meshPath: string | null;
  characterIdHint: string | null;
  variantIdHint: string | null;
  isCamera: boolean;
  animSections: CutsceneAnimSectionDto[];
  transformTracks: CutsceneTransformTrackDto[];
  cameraFovTracks: CutsceneFloatChannelDto[];
}

export interface CutsceneCameraCutDto {
  startTime: number;
  endTime: number;
  cameraGuid: string;
}

export interface CutsceneDetailDto {
  path: string;
  name: string;
  duration: number;
  displayRate: number;
  tickResolution: number;
  actors: CutsceneActorDto[];
  cameraCuts: CutsceneCameraCutDto[];
}

export type ShaderRenderMode = 'wuwa-toon' | 'pbr' | 'flat-albedo' | 'wireframe';

export interface InteractiveSphereDto {
  id: string;
  name: string;
  position: [number, number, number];
  radius: number;
  enabled: boolean;
}

export interface PhysicsRuntimeOptions {
  enabled: boolean;
  stiffnessScale: number;
  dampingScale: number;
  gravityScale: number;
  windStrength: number;
  windFrequency: number;
  showColliders: boolean;
  showChains: boolean;
  sphereBounciness: number;
}

