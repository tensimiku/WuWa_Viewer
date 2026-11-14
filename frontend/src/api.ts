import type {
  AnimationItemDto,
  AnimationPayloadDto,
  CharacterSummaryDto,
  CutsceneDetailDto,
  CutsceneSummaryDto,
  ModelFormMaterialsDto,
  ModelManifestDto,
  PhysicsConfigDto,
  WeaponSummaryDto
} from './types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${url}: ${txt}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => getJson<{ ok: boolean; mountedVfs: number; totalFiles: number; characters: number; weapons: number; cutscenes: number }>('/api/health'),
  characters: () => getJson<CharacterSummaryDto[]>('/api/characters'),
  characterDetail: (id: string) => getJson<CharacterSummaryDto>(`/api/characters/${encodeURI(id)}`),
  weapons: (q?: string, limit = 150) =>
    getJson<WeaponSummaryDto[]>(`/api/weapons?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  modelManifest: (path: string) =>
    getJson<ModelManifestDto>(`/api/model/manifest?path=${encodeURIComponent(path)}`),
  modelFormMaterials: (path: string) =>
    getJson<ModelFormMaterialsDto>(`/api/model/form-materials?path=${encodeURIComponent(path)}`),
  textureUrl: (path: string) => `/api/texture?path=${encodeURIComponent(path)}`,
  animations: (characterId: string, includeShared = true) =>
    getJson<AnimationItemDto[]>(`/api/animations?characterId=${encodeURIComponent(characterId)}&includeShared=${includeShared}`),
  animation: (path: string, ribbonPath?: string | null) =>
    getJson<AnimationPayloadDto>(`/api/animation?path=${encodeURIComponent(path)}${ribbonPath ? `&ribbonPath=${encodeURIComponent(ribbonPath)}` : ''}`),
  physics: (characterId: string, abp?: string | null) =>
    getJson<PhysicsConfigDto>(`/api/physics?characterId=${encodeURIComponent(characterId)}${abp ? `&abp=${encodeURIComponent(abp)}` : ''}`),
  cutscenes: (params: { character?: string; category?: string; q?: string; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params.character) sp.set('character', params.character);
    if (params.category) sp.set('category', params.category);
    if (params.q) sp.set('q', params.q);
    sp.set('limit', String(params.limit ?? 150));
    return getJson<CutsceneSummaryDto[]>(`/api/cutscenes?${sp.toString()}`);
  },
  cutsceneDetail: (path: string) =>
    getJson<CutsceneDetailDto>(`/api/cutscene?path=${encodeURIComponent(path)}`)
};

