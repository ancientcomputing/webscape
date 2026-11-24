// Bridge for the sidebar UI. Exposes a fixed set of channels, nothing else.
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE = new Set([
  'ui:state', 'ui:newTab', 'ui:select', 'ui:close', 'ui:navigate', 'ui:nav', 'ui:focusPage', 'ui:overlay', 'ui:setLegacy', 'ui:setTheme', 'ui:addressPopover', 'ui:addressPopoverClose', 'ui:addressPopoverHeight', 'ui:searchView', 'ui:answersFirst', 'ui:openResult', 'ui:home', 'ui:layout',
  'ui:vaultUnlock', 'ui:vaultLock', 'ui:vaultList', 'ui:vaultCopy', 'ui:vaultDelete', 'ui:vaultAdd',
  'ui:copySecret', 'ui:fillCandidates', 'ui:fill', 'ui:saveDecision',
  'ui:bookmarks', 'ui:bookmarkToggle', 'ui:bookmarkAdd', 'ui:bookmarkUndo', 'ui:bookmarkOpen', 'ui:bookmarkSave', 'ui:bookmarkDelete',
  'ui:folderAdd', 'ui:folderRename', 'ui:folderDelete', 'ui:bookmarksUnlock', 'ui:bookmarksLock',
  'ui:bookmarksSetTouchID', 'ui:bookmarksImport', 'ui:bookmarksExport',
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
  onBookmarks: (cb: (b: unknown) => void) => {
    ipcRenderer.on('bookmarks', (_e, b) => cb(b));
  },
  onToast: (cb: (t: unknown) => void) => {
    ipcRenderer.on('toast', (_e, t) => cb(t));
  },
});
