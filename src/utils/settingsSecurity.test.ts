import { describe, expect, it } from "vitest";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../store/appSettings";
import { buildExportSettings, mergeImportedSettings } from "./settingsSecurity";

const buildSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_APP_SETTINGS,
  ...overrides,
});

describe("buildExportSettings", () => {
  it("redacts sync and AI secrets from exported settings", () => {
    const settings = buildSettings({
      "ai.openai.apiKey": "openai-secret",
      "sync.webdav.username": "alice",
      "sync.webdav.password": "pw",
      "sync.s3.accessKeyId": "ak",
      "sync.s3.secretAccessKey": "sk",
    });

    const exported = buildExportSettings(settings);

    expect(exported["ai.openai.apiKey"]).toBe("");
    expect(exported["sync.webdav.username"]).toBe("");
    expect(exported["sync.webdav.password"]).toBe("");
    expect(exported["sync.s3.accessKeyId"]).toBe("");
    expect(exported["sync.s3.secretAccessKey"]).toBe("");
  });
});

describe("mergeImportedSettings", () => {
  it("preserves protected secrets when import leaves them blank", () => {
    const current = buildSettings({
      "ai.openai.apiKey": "keep-me",
    });

    const merged = mergeImportedSettings(current, {
      "ai.openai.apiKey": "",
    });

    expect(merged["ai.openai.apiKey"]).toBe("keep-me");
  });

  it("clears stored WebDAV credentials when an imported endpoint changes without new credentials", () => {
    const current = buildSettings({
      "sync.webdav.endpoint": "https://safe.example.com",
      "sync.webdav.username": "alice",
      "sync.webdav.password": "pw",
    });

    const merged = mergeImportedSettings(current, {
      "sync.webdav.endpoint": "https://evil.example.com",
    });

    expect(merged["sync.webdav.username"]).toBe("");
    expect(merged["sync.webdav.password"]).toBe("");
  });

  it("keeps imported WebDAV credentials when the endpoint changes and new credentials are supplied", () => {
    const current = buildSettings({
      "sync.webdav.endpoint": "https://safe.example.com",
      "sync.webdav.username": "alice",
      "sync.webdav.password": "pw",
    });

    const merged = mergeImportedSettings(current, {
      "sync.webdav.endpoint": "https://new.example.com",
      "sync.webdav.username": "bob",
      "sync.webdav.password": "next",
    });

    expect(merged["sync.webdav.username"]).toBe("bob");
    expect(merged["sync.webdav.password"]).toBe("next");
  });
});
