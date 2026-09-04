import { beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from "@/lib/constants";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  readStoredSettings,
  saveSettings,
} from "@/lib/settings-storage";

/**
 * Minimal in-memory Storage stand-in, so these tests need no browser.
 * @returns a Storage-compatible object backed by a Map
 */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  } as Storage;
}

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
});

describe("readStoredSettings", () => {
  it("accepts only known string fields", () => {
    const settings = readStoredSettings({
      baseUrl: "https://api.example.com",
      model: 42,
      injected: "ignored",
    });
    expect(settings.baseUrl).toBe("https://api.example.com");
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(settings).not.toHaveProperty("injected");
  });

  it("falls back to defaults for a non-object value", () => {
    expect(readStoredSettings("corrupt")).toEqual(DEFAULT_SETTINGS);
    expect(readStoredSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("saveSettings", () => {
  it("keeps the credential out of the settings record", () => {
    saveSettings(storage, {
      baseUrl: "https://api.example.com",
      model: "test-model",
      apiKey: "sk-secret-value",
    });
    const record = storage.getItem(SETTINGS_STORAGE_KEY) ?? "";
    expect(record).not.toContain("sk-secret-value");
    expect(record).not.toContain("apiKey");
    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBe("sk-secret-value");
  });
});

describe("loadSettings", () => {
  it("restores what saveSettings wrote", () => {
    const original = {
      baseUrl: "https://api.example.com",
      model: "test-model",
      apiKey: "sk-secret-value",
    };
    saveSettings(storage, original);
    expect(loadSettings(storage)).toEqual(original);
  });

  it("migrates a key left in the legacy combined record", () => {
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        baseUrl: "https://api.example.com",
        model: "test-model",
        apiKey: "sk-legacy-value",
      }),
    );

    expect(loadSettings(storage).apiKey).toBe("sk-legacy-value");
    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBe("sk-legacy-value");
  });

  it("clears the key out of the legacy record while migrating it", () => {
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ model: "test-model", apiKey: "sk-legacy-value" }),
    );

    loadSettings(storage);

    const legacy = storage.getItem(SETTINGS_STORAGE_KEY) ?? "";
    expect(legacy).not.toContain("sk-legacy-value");
    expect(legacy).not.toContain("apiKey");
  });

  it("prefers the dedicated record over a stale legacy copy", () => {
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ model: "test-model", apiKey: "sk-stale" }),
    );
    storage.setItem(API_KEY_STORAGE_KEY, "sk-current");
    expect(loadSettings(storage).apiKey).toBe("sk-current");
  });

  it("returns defaults for an empty store", () => {
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });
});
