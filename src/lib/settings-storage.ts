/**
 * Browser persistence for the user's LLM settings.
 *
 * The API key lives in its own record rather than inside the settings object,
 * so anything that reads, renders, or exports the settings cannot carry the
 * credential along with it. Kept out of the page component for the same reason
 * chat-state and chat-history are: it is logic, and logic is testable.
 */

import {
  API_KEY_STORAGE_KEY,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  SETTINGS_STORAGE_KEY,
} from "@/lib/constants";

/** The provider settings one browser holds. */
export interface Settings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Settings used before the user has saved any of their own. */
export const DEFAULT_SETTINGS: Settings = {
  baseUrl: DEFAULT_LLM_BASE_URL,
  model: DEFAULT_LLM_MODEL,
  apiKey: "",
};

/**
 * Accept only known string fields from a persisted settings record. The value
 * comes from browser storage, which the user can edit, so its shape is
 * narrowed rather than asserted.
 * @param stored the parsed storage value, of unknown shape
 * @returns the defaults with any valid stored fields applied
 */
export function readStoredSettings(stored: unknown): Settings {
  if (typeof stored !== "object" || stored === null) return DEFAULT_SETTINGS;
  const source = stored as Record<string, unknown>;
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = source[key];
    if (typeof value === "string") settings[key] = value;
  }
  return settings;
}

/**
 * Load settings, taking the API key from its own record. Earlier versions kept
 * the key inside the settings blob, so a key found there is moved across once
 * instead of being left behind or lost.
 * @param storage the browser store to read, injectable for tests
 * @returns the restored settings
 */
export function loadSettings(storage: Storage): Settings {
  let settings = DEFAULT_SETTINGS;
  const storedSettings = storage.getItem(SETTINGS_STORAGE_KEY);
  if (storedSettings) {
    try {
      settings = readStoredSettings(JSON.parse(storedSettings));
    } catch {
      // Corrupt settings fall back to defaults.
    }
  }
  const storedKey = storage.getItem(API_KEY_STORAGE_KEY);
  if (storedKey !== null) return { ...settings, apiKey: storedKey };
  if (settings.apiKey) {
    storage.setItem(API_KEY_STORAGE_KEY, settings.apiKey);
    saveSettings(storage, settings);
  }
  return settings;
}

/**
 * Persist settings, keeping the credential in its own record.
 * @param storage the browser store to write, injectable for tests
 * @param settings the settings to persist
 */
export function saveSettings(storage: Storage, settings: Settings): void {
  const { apiKey, ...shareable } = settings;
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(shareable));
  storage.setItem(API_KEY_STORAGE_KEY, apiKey);
}
