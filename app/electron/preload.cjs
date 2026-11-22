const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  settings: { get: invoke('settings:get'), save: invoke('settings:save'), dirOf: invoke('settings:dirOf') },
  env: { check: invoke('env:check') },
  stats: { get: invoke('stats:get') },
  dialog: { open: invoke('dialog:open'), pickDir: invoke('dialog:pickDir') },
  fs: { expand: invoke('fs:expand'), readText: invoke('fs:readText') },
  media: { probe: invoke('media:probe'), thumb: invoke('media:thumb'), size: invoke('media:size') },
  shell: { open: invoke('shell:open'), show: invoke('shell:show'), openExternal: invoke('shell:openExternal') },
  jobs: {
    snapshot: invoke('jobs:snapshot'),
    add: invoke('jobs:add'),
    start: invoke('jobs:start'),
    pause: invoke('jobs:pause'),
    stop: invoke('jobs:stop'),
    retry: invoke('jobs:retry'),
    remove: invoke('jobs:remove'),
    clear: invoke('jobs:clear'),
    updateInputs: invoke('jobs:updateInputs'),
    onUpdate: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('jobs:update', h);
      return () => ipcRenderer.removeListener('jobs:update', h);
    },
  },
  styles: { get: invoke('styles:get'), save: invoke('styles:save') },
  collect: { parse: invoke('collect:parse'), login: invoke('collect:login'), clearSession: invoke('collect:clearSession') },
  vcat: {
    hasToken: invoke('vcat:hasToken'),
    connect: invoke('vcat:connect'),
    forgetToken: invoke('vcat:forgetToken'),
    disconnect: invoke('vcat:disconnect'),
    status: invoke('vcat:status'),
    accounts: invoke('vcat:accounts'),
    autoMapping: invoke('vcat:autoMapping'),
  },
  publish: { draft: invoke('publish:draft'), saveDraft: invoke('publish:saveDraft'), addToDraft: invoke('publish:addToDraft') },
  tts: {
    hasKey: invoke('tts:hasKey'),
    testKey: invoke('tts:testKey'),
    clearKey: invoke('tts:clearKey'),
    sample: invoke('tts:sample'),
    preview: invoke('tts:preview'),
  },
  avatars: { list: invoke('avatars:list'), add: invoke('avatars:add'), remove: invoke('avatars:remove'), rename: invoke('avatars:rename') },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
