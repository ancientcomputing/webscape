// Types shared between the main process and the sidebar UI.

export interface TabState {
  id: number;
  title: string;
  /** URL shown in the address bar ("" for the start page). */
  url: string;
  host: string;
  loading: boolean;
  secure: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Requests blocked by the tracker blocker in this tab. */
  blocked: number;
  /** Tab opened as a popup by another tab: it shares that tab's memory so sign-in popups work. */
  linkedTo: number | null;
}

export interface SavePrompt {
  tabId: number;
  origin: string;
  username: string;
  /** True when this would replace a saved password for the same username. */
  update: boolean;
}

export interface AppState {
  tabs: TabState[];
  activeId: number | null;
  vaultUnlocked: boolean;
  vaultAvailable: boolean;
  /** The active tab shows a password field and has a fillable origin. */
  loginForm: { origin: string } | null;
  savePrompt: SavePrompt | null;
}

export interface VaultEntrySummary {
  id: string;
  origin: string;
  username: string;
  updated: number;
}

export type NavAction = 'back' | 'forward' | 'reload' | 'stop';

export type UICommand = 'focus-address' | 'toggle-vault' | 'new-tab-focus';
