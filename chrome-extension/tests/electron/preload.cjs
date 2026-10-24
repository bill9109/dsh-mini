const { contextBridge, ipcRenderer } = require('electron')

// The production content script only uses chrome.runtime.sendMessage; this bridge
// replaces that transport with a direct call into the Host so the real script runs unmodified.
contextBridge.exposeInMainWorld('dshBridge', {
  send: message => ipcRenderer.invoke('dsh-bridge', message),
})
