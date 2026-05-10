import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  openMainWindow: () => ipcRenderer.invoke('open-main-window'),
  getBackendUrl:  () => ipcRenderer.invoke('get-backend-url'),
});
