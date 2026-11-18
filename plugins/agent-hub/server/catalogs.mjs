import { backendOf } from './common.mjs';

const efforts = items => (items ?? []).map(item => typeof item === 'string' ? item : item.id);
export function normalizeCatalog(backend, raw) {
  if (backend === 'codex') {
    const projects = raw.projects ?? [];
    const workspace = projects.find(project => project.id === raw.defaults?.project)?.root;
    return {
      models: raw.models ?? [],
      workspaces: projects.map(project => ({ path: project.root, title: project.name })),
      permissions: raw.permissions ?? [],
      defaults: { ...raw.defaults, ...(workspace ? { workspace } : {}) },
    };
  }
  return {
    workspaces: (raw.workspaces ?? []).map(item => ({ path: item.path, title: item.title })),
    presets: raw.presets?.presets ?? [],
    models: (raw.models?.groups ?? []).flatMap(group => (group.models ?? []).map(model => ({
      id: model.id, name: model.name ?? model.id, provider: group.id, providerName: group.name ?? group.id,
      efforts: efforts(model.reasoning?.efforts), defaultEffort: model.reasoning?.defaultEffort,
    }))),
    permissions: (raw.permissions?.options ?? []).map(option => option.value),
    defaults: {
      preset: raw.presets?.presets?.find(preset => preset.isDefault)?.id,
      provider: raw.models?.default?.provider, model: raw.models?.default?.model, effort: raw.models?.default?.reasoningEffort,
      permission: raw.permissions?.defaultPreset,
    },
  };
}

export function catalogReader(read) {
  const cache = new Map();
  return async params => {
    const backend = backendOf(params);
    const mode = backend === 'dsh' ? params.mode ?? 'headless' : undefined;
    if (mode && !['desktop', 'headless'].includes(mode)) throw new Error('Choose desktop or headless');
    const key = mode ?? backend;
    const cached = cache.get(key);
    if (cached && !params.refresh && Date.now() - cached.at < 60000) return cached.value;
    const value = normalizeCatalog(backend, await read(backend, mode, params.refresh === true));
    cache.set(key, { at: Date.now(), value });
    return value;
  };
}
