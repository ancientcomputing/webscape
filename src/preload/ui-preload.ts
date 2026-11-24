// Bridge for the sidebar UI. Exposes a fixed set of channels, nothing else.
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE = new Set([
  'ui:state', 'ui:newTab', 'ui:select', 'ui:close', 'ui:navigate', 'ui:nav', 'ui:focusPage', 'ui:overlay', 'ui:setLegacy', 'ui:setTheme', 'ui:addressPopover', 'ui:addressPopoverClose', 'ui:addressPopoverHeight', 'ui:home', 'ui:layout',
  'ui:vaultUnlock', 'ui:vaultLock', 'ui:vaultList', 'ui:vaultCopy', 'ui:vaultDelete', 'ui:vaultAdd',
  'ui:copySecret', 'ui:fillCandidates', 'ui:fill', 'ui:saveDecision',
]);

contextBridge.exposeInMainWorld('webscape', {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  onState: (cb: (state: unknown) => void) => {
    ipcRenderer.on('state', (_e, s) => cb(s));
  },
  onCommand: (cb: (cmd: string) => void) => {
    ipcRenderer.on('command', (_e, c) => cb(c));
  },
  onPopover: (cb: (p: unknown) => void) => {
    ipcRenderer.on('popover', (_e, p) => cb(p));
  },
});
