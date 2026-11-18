const permissionNames = { 'read-only': '只读', 'workspace-write': '工作区写入', 'danger-full-access': '完全权限' };
const customLocation = '';
const dshModelKey = (provider, model) => JSON.stringify([provider, model]);
const workspaceKey = value => value?.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

function workspaces(catalog) {
  const paths = new Map();
  for (const item of catalog.workspaces ?? []) {
    const key = workspaceKey(item.path);
    if (key && !paths.has(key)) paths.set(key, item);
  }
  return paths;
}

function sameValues(values, previous) {
  return Object.keys(values).length === Object.keys(previous).length && Object.entries(values).every(([key, value]) => {
    const other = previous[key];
    return value && typeof value === 'object'
      ? other && typeof other === 'object' && sameValues(value, other)
      : value === other;
  });
}

function selectOptions(select, options, value, groupNames = {}) {
  const list = [...options];
  if (value && !list.some(option => option.value === value)) list.push({ value, label: value + ' · 当前值' });
  const groups = new Map();
  select.replaceChildren();
  for (const { value, label, group } of list) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    if (group && !groups.has(group)) {
      const section = document.createElement('optgroup');
      section.label = groupNames[group] ?? group;
      groups.set(group, section);
      select.append(section);
    }
    (groups.get(group) ?? select).append(node);
  }
  select.value = value ?? '';
}

function createSettings(call) {
  const get = id => document.getElementById(id);
  const form = get('settings');
  const field = name => form.elements.namedItem(name);
  const saveButton = form.querySelector('button[type="submit"]');
  const discardButton = get('discard-settings');
  const reloadButton = get('refresh-catalog');
  const status = get('configuration-status');
  const states = new Map();
  const catalogs = new Map();
  let current;
  let catalogRequest;

  const originalValues = state => ({
    ...state.entry.values, workspace: state.suggestedWorkspace ?? state.entry.values.workspace,
  });
  const originalRoute = entry => entry.subagentRoute ?? 'agent-hub';
  const dirty = state => !sameValues(state.values, originalValues(state)) || state.subagentRoute !== originalRoute(state.entry);

  function renderStatus(state) {
    const firstSave = state.entry.status !== 'ready';
    const edited = dirty(state);
    const detail = edited ? '有未保存的修改' : firstSave ? '尚未保存' : '已保存';
    status.textContent = state.saving ? '正在保存…' : firstSave ? '首次配置 · ' + detail : detail;
    status.className = 'configuration-status' + (state.saving ? '' : edited ? ' dirty' : firstSave ? '' : ' saved');
    status.hidden = false;
    get('save-error').textContent = state.error ?? '';
    saveButton.disabled = state.saving || (!firstSave && !edited);
    discardButton.hidden = !edited;
    discardButton.disabled = state.saving === true;
  }

  const catalogKey = state => state.backend === 'dsh' ? state.values.mode : 'codex';
  const catalogOf = state => catalogs.get(catalogKey(state)) ?? {};
  function modelOf(state, catalog) {
    const { model, preset } = state.values;
    if (state.backend === 'dsh') {
      const defaults = catalog.defaults;
      const selection = model ?? (!preset || preset === defaults?.preset ? defaults : undefined);
      return catalog.models?.find(item => item.provider === selection?.provider && item.id === selection?.model);
    }
    return catalog.models?.find(item => item.id === (model ?? catalog.defaults?.model));
  }
  function render(state) {
    if (state !== current) return;
    const dsh = state.backend === 'dsh';
    const { values } = state;
    const catalog = catalogOf(state);
    const defaults = catalog.defaults ?? {};
    const models = catalog.models ?? [];
    const currentModel = modelOf(state, catalog);
    const model = dsh ? values.model && dshModelKey(values.model.provider, values.model.model) : values.model;
    const effort = dsh ? values.model?.reasoningEffort : values.effort;
    if (dsh) field('mode').value = values.mode;
    else field('subagentRoute').value = state.subagentRoute;
    get('setting-mode').hidden = !dsh;
    get('setting-subagent-route').hidden = dsh;
    get('setting-preset').hidden = !dsh;
    get('location-label').textContent = dsh ? '工作区' : '项目 / 工作区';
    get('permission-label').textContent = dsh ? '权限' : '沙箱';

    const paths = workspaces(catalog);
    const nameCounts = new Map();
    for (const { title } of paths.values()) {
      if (title) nameCounts.set(title, (nameCounts.get(title) ?? 0) + 1);
    }
    const options = [...paths.values()].map(({ path, title }) => ({
      value: path, label: nameCounts.get(title) > 1 ? title + ' · ' + path : title || path,
    }));
    const selected = paths.get(workspaceKey(values.workspace));
    const custom = state.custom === true || !selected;
    selectOptions(field('location'), [...options, { value: customLocation, label: '自定义目录…' }], custom ? customLocation : selected.path);
    get('location-path').textContent = custom ? '' : selected.path;
    get('location-path').hidden = custom;
    get('setting-workspace').hidden = !custom;
    field('workspace').value = values.workspace;

    const presetName = catalog.presets?.find(item => item.id === defaults.preset)?.name ?? defaults.preset;
    selectOptions(field('preset'), [{ value: '', label: '沿用 DSH 默认' + (presetName ? '（' + presetName + '）' : '') },
      ...(catalog.presets ?? []).map(item => ({ value: item.id, label: item.name ?? item.id }))], values.preset);
    const inherit = dsh ? (values.preset ? '沿用预设' : '沿用 DSH 默认') : '沿用 Codex 配置';
    const modelOptions = [{ value: '', label: inherit + (defaults.model && (!dsh || !values.preset) ? '（' + defaults.model + '）' : '') }];
    for (const item of models) modelOptions.push({ value: dsh ? dshModelKey(item.provider, item.id) : item.id, label: item.name ?? item.id, group: dsh ? item.provider : undefined });
    if (model && !currentModel) modelOptions.push({ value: model, label: (dsh ? values.model.model + ' · ' + values.model.provider : model) + ' · 当前值' });
    selectOptions(field('model'), modelOptions, model, Object.fromEntries(models.filter(item => item.provider).map(item => [item.provider, item.providerName])));
    const defaultEffort = !model && (!dsh || currentModel)
      ? defaults.effort ?? currentModel?.defaultEffort
      : currentModel?.defaultEffort;
    const availableEfforts = currentModel?.efforts ?? [];
    selectOptions(field('effort'), [{ value: '', label: '沿用默认' + (defaultEffort ? '（' + defaultEffort + '）' : '') },
      ...availableEfforts.map(value => ({ value, label: value }))], effort);
    field('effort').disabled = !availableEfforts.length && !effort;
    const effortHint = dsh && !model
      ? availableEfforts.length ? '指定档位时会同时选中当前默认模型。' : values.preset ? '如需指定档位，请先选择支持推理档位的模型。' : ''
      : '';
    get('effort-hint').textContent = effortHint;
    get('effort-hint').hidden = !effortHint;
    const permissions = catalog.permissions?.length ? catalog.permissions : Object.keys(permissionNames);
    selectOptions(field('permission'), [{ value: '', label: '沿用默认' + (defaults.permission ? '（' + (permissionNames[defaults.permission] ?? defaults.permission) + '）' : '') },
      ...permissions.map(value => ({ value, label: permissionNames[value] ?? value }))], dsh ? values.permission : values.sandbox);
    form.hidden = false;
    renderStatus(state);
  }

  async function loadCatalog(state, refresh) {
    const key = catalogKey(state);
    const request = catalogRequest = {};
    get('catalog-status').textContent = '正在读取可选项…';
    reloadButton.disabled = true;
    try {
      const catalog = await call('catalog', { backend: state.backend, mode: state.values.mode, refresh });
      if (request !== catalogRequest) return;
      catalogs.set(key, catalog);
      if (state.entry.status === 'draft' && !state.saving) {
        const paths = workspaces(catalog);
        const suggestion = paths.get(workspaceKey(state.entry.initialWorkspace)) ?? paths.get(workspaceKey(catalog.defaults?.workspace));
        state.suggestedWorkspace = suggestion?.path;
        if (!state.workspaceChosen) state.values.workspace = originalValues(state).workspace;
      }
      get('catalog-status').textContent = '';
      render(state);
    } catch (error) {
      if (request === catalogRequest) {
        get('catalog-status').textContent = (refresh ? error.message : '目录暂不可用。可保留当前值，或点击「读取可选项」连接该后端。');
      }
    } finally {
      if (request === catalogRequest) reloadButton.disabled = false;
    }
  }

  form.onchange = event => {
    if (!current?.entry) return;
    const { name, value } = event.target;
    const state = current;
    const { values } = state;
    const dsh = state.backend === 'dsh';
    const set = (key, selection) => { if (selection) values[key] = selection; else delete values[key]; };
    if (name === 'location') {
      state.workspaceChosen = true;
      state.custom = !value;
      if (value) values.workspace = value;
    } else if (name === 'subagentRoute') state.subagentRoute = value;
    else if (name === 'workspace' || name === 'mode') values[name] = value;
    else if (name === 'permission') set(dsh ? 'permission' : 'sandbox', value);
    else if (name === 'model') {
      const previous = dsh ? values.model?.reasoningEffort : values.effort;
      if (dsh && value) {
        const [provider, model] = JSON.parse(value);
        values.model = { provider, model };
        if (modelOf(state, catalogOf(state))?.efforts?.includes(previous)) values.model.reasoningEffort = previous;
      } else {
        set('model', value);
        if (!modelOf(state, catalogOf(state))?.efforts?.includes(previous)) delete values.effort;
      }
    } else if (name === 'effort') {
      if (dsh) {
        const selected = modelOf(state, catalogOf(state));
        if (value && selected?.efforts?.includes(value)) {
          values.model = { provider: selected.provider, model: selected.id, reasoningEffort: value };
        } else if (!value && values.model) {
          delete values.model.reasoningEffort;
        }
      } else set('effort', value);
    } else if (name === 'preset') set('preset', value);
    state.error = '';
    render(state);
    if (name === 'mode') void loadCatalog(state, false);
  };
  form.oninput = event => {
    if (!current?.entry || event.target.name !== 'workspace') return;
    current.values.workspace = event.target.value;
    current.workspaceChosen = true;
    current.error = '';
    renderStatus(current);
  };
  discardButton.onclick = () => {
    if (!current?.entry || current.saving) return;
    current.values = structuredClone(originalValues(current));
    current.subagentRoute = originalRoute(current.entry);
    current.workspaceChosen = false;
    current.custom = false;
    current.error = '';
    render(current);
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const state = current;
    if (!state?.entry || state.saving || (state.entry.status === 'ready' && !dirty(state))) return;
    const values = structuredClone(state.values);
    const { configurationId, revision } = state.entry;
    const { subagentRoute } = state;
    state.saving = true;
    state.error = '';
    renderStatus(state);
    try {
      state.entry = await call('saveConfiguration', { backend: state.backend, configurationId, revision, values,
        ...(state.backend === 'codex' ? { subagentRoute } : {}) });
      state.suggestedWorkspace = undefined;
      if (sameValues(state.values, values) && state.subagentRoute === subagentRoute) {
        state.values = structuredClone(state.entry.values);
        state.subagentRoute = originalRoute(state.entry);
      }
    } catch (error) {
      state.error = '保存失败：' + error.message;
    } finally {
      state.saving = false;
      render(state);
    }
  };
  reloadButton.onclick = () => { if (current?.entry) void loadCatalog(current, true); };

  return async backend => {
    if (current?.backend === backend && current.entry) return;
    catalogRequest = undefined;
    let state = states.get(backend);
    if (!state) {
      state = { backend };
      states.set(backend, state);
    }
    current = state;
    for (const name of ['dsh', 'codex']) get('backend-' + name).setAttribute('aria-pressed', String(name === backend));
    if (!state.entry) {
      form.hidden = true;
      status.hidden = true;
      reloadButton.disabled = true;
      get('catalog-status').textContent = '正在加载配置…';
      try {
        state.pending ??= call('configurationDraft', { backend });
        state.entry = await state.pending;
        state.values = structuredClone(state.entry.values);
        state.subagentRoute = originalRoute(state.entry);
      } catch (error) {
        if (state === current) get('catalog-status').textContent = error.message;
        return;
      } finally { state.pending = undefined; }
    }
    if (state !== current) return;
    render(state);
    void loadCatalog(state, false);
  };
}
