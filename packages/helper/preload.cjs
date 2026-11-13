const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('companion', {
  submit: (payload) => ipcRenderer.invoke('companion:submit', payload),
  newSession: () => ipcRenderer.invoke('companion:new-session'),
  interactive: (value) => ipcRenderer.send('companion:interactive', value),
  closePanel: () => ipcRenderer.send('companion:close-panel'),
  quit: () => ipcRenderer.send('companion:quit'),
  drag: (phase) => ipcRenderer.send('companion:drag', phase),
  onHost: (cb) => ipcRenderer.on('companion:host', (_event, frame) => cb(frame)),
  onOpen: (cb) => ipcRenderer.on('companion:open', () => cb()),
})
