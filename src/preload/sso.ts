// 원격 SSO 완료 응답만 메인 프로세스로 전달하는 격리된 팝업 브리지
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../main/ipc';

contextBridge.exposeInMainWorld('xgenConnectorSsoComplete', (payload: unknown): void => {
  ipcRenderer.send(CHANNELS.authSsoComplete, payload);
});
