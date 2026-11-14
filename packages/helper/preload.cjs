const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('companion', {
  // ball window
  ballClick: () => ipcRenderer.send('companion:ball-click'),
  drag: (phase) => ipcRenderer.send('companion:drag', phase),

  // panel window
  submit: (payload) => ipcRenderer.invoke('companion:submit', payload),
  newSession: () => ipcRenderer.invoke('companion:new-session'),
  closePanel: () => ipcRenderer.send('companion:close-panel'),
  bubbleSize: (height) => ipcRenderer.send('companion:bubble-size', height),
  panelSize: (height) => ipcRenderer.send('companion:panel-size', height),
  hideBubble: () => ipcRenderer.send('companion:hide-bubble'),
  quit: () => ipcRenderer.send('companion:quit'),
  log: (message) => ipcRenderer.send('companion:log', String(message)),

  onHost: (cb) => ipcRenderer.on('companion:host', (_event, frame) => cb(frame)),
  onHover: (cb) => ipcRenderer.on('companion:hover', (_event, inside) => cb(inside)),
  onOpen: (cb) => ipcRenderer.on('companion:open', () => cb()),
  onClose: (cb) => ipcRenderer.on('companion:close', () => cb()),
})
