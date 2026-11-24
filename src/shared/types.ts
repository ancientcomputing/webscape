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
  /** Retro 90s look. */
  legacy: boolean;
  /** The user's appearance choice, and whether dark colors are in effect right now. */
  theme: ThemeSetting;
  dark: boolean;
  bookmarks: BookmarksState;
  /** The active tab shows a password field and has a fillable origin. */
  loginForm: { origin: string } | null;
  savePrompt: SavePrompt | null;
  /** The active tab is a search results page that can be analyzed. */
  search: { query: string } | null;
  /** Preference: open searches on the Answers view (analyzes every search automatically). */
  answersFirst: boolean;
  /** AI analysis of the active tab's search results, if one was started. */
  insights: InsightsState | null;
}

/** One search result, as read and judged by the on-device model. */
export interface ResultInsight {
  url: string;
  host: string;
  title: string;
  snippet: string;
  /** queued → reading (fetching the page) → judging (model) → done, or error. */
  status: 'queued' | 'reading' | 'judging' | 'done' | 'error';
  /** 0–100: how likely the page answers the search. */
  score?: number;
  answers?: 'yes' | 'partly' | 'no';
  summary?: string;
  /** A short quote from the page that best answers the search. */
  evidence?: string;
  /** Short reasons for the score, e.g. ["direct", "detailed", "focused"]. */
  factors?: string[];
  /** The page only showed its text with JavaScript (read by the JavaScript pass). */
  rendered?: boolean;
  /** A listicle ("Top 10…", "15 best…"): scored 0. */
  listicle?: boolean;
  error?: string;
}

export type SearchView = 'results' | 'answers';

export interface InsightsState {
  query: string;
  /** Which view of the search the tab shows: DuckDuckGo's page, or the ranked answers. */
  view: SearchView;
  /** 'unavailable': the on-device model can't run; see detail. */
  status: 'starting' | 'running' | 'done' | 'unavailable' | 'error';
  detail: string;
  model: string;
  results: ResultInsight[];
}

export interface Bookmark {
  id: string;
  title: string;
  /** Cleaned of tracking parameters when saved. */
  url: string;
  folder: string;
  created: number;
}

export interface BookmarkData {
  /** Folder names in display order; "Favorites" is always first. */
  folders: string[];
  bookmarks: Bookmark[];
}

export interface BookmarksState {
  /** The OS can encrypt them (false: bookmarks can't be saved). */
  available: boolean;
  unlocked: boolean;
  touchIDRequired: boolean;
  /** The bookmark for the active tab's page, if it has one. */
  activeId: string | null;
}

export interface VaultEntrySummary {
  id: string;
  origin: string;
  username: string;
  updated: number;
}

export type ThemeSetting = 'system' | 'light' | 'dark';

export type NavAction = 'back' | 'forward' | 'reload' | 'stop';

export type UICommand = 'focus-address' | 'toggle-vault' | 'toggle-bookmarks' | 'new-tab-focus';
