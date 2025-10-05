const browserApi = typeof browser !== "undefined" ? browser : chrome;
const IS_CHROME = typeof browser === "undefined";
const actionApi = (typeof browserApi !== "undefined" && browserApi)
  ? (browserApi.action || browserApi.browserAction || null)
  : null;

const SUPPORTED_LANGUAGES = new Set(["en", "ja", "zh_CN"]);
const DEFAULT_LANGUAGE = "en";
const DEFAULT_SETTINGS = {
  language: DEFAULT_LANGUAGE,
  range: "all",
  customRangeStart: 1,
  customRangeEnd: 1,
  antiTheft: true,
  overlay: true,
  rootFolder: "Pixiv",
  retryFailed: true
};

let currentSettings = { ...DEFAULT_SETTINGS };
const LANGUAGE_BUNDLES = new Map();

const FALLBACK_MESSAGES = {
  fallbackArtworkTitle: (illustId) => {
    const value = Array.isArray(illustId) ? illustId[0] : illustId;
    return `Pixiv Artwork ${value ?? ""}`.trim();
  },
  fallbackUnknownCreator: "Unknown Creator",
  errorActiveTabMissing: "Could not find an active tab.",
  errorNoImagesForDownload: "No images were found to download.",
  errorNoDownloadableImages: "No downloadable images were found on this artwork.",
  errorDownloadImageFailed: (status) => {
    const value = Array.isArray(status) ? status[0] : status;
    return `Failed to fetch image (${value ?? "?"})`;
  },
  errorUnknown: "Unknown error."
};

function normalizeLanguage(value) {
  if (!value || value === "auto") {
    return DEFAULT_LANGUAGE;
  }
  if (SUPPORTED_LANGUAGES.has(value)) {
    return value;
  }
  return DEFAULT_LANGUAGE;
}

function renderMessage(template, placeholders, substitutions) {
  if (!template) {
    return null;
  }

  if (!substitutions) {
    return template;
  }

  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let result = template;

  if (placeholders && typeof placeholders === "object") {
    for (const [name, descriptor] of Object.entries(placeholders)) {
      if (!descriptor || typeof descriptor.content !== "string") {
        continue;
      }

      const match = descriptor.content.match(/\$(\d+)/);
      if (!match) {
        continue;
      }

      const index = Number(match[1]) - 1;
      if (index < 0 || index >= values.length) {
        continue;
      }

      const replacement = values[index];
      if (replacement === undefined || replacement === null) {
        continue;
      }

      const token = `$${name.toUpperCase()}$`;
      result = result.replace(new RegExp(token, "g"), String(replacement));
    }
  }

  result = result.replace(/\$(\d+)\$/g, (match, group) => {
    const index = Number(group) - 1;
    const replacement = values[index];
    return replacement === undefined || replacement === null ? match : String(replacement);
  });

  return result;
}

async function loadLocaleBundle(locale) {
  if (!locale || locale === "auto") {
    return null;
  }

  if (LANGUAGE_BUNDLES.has(locale)) {
    return LANGUAGE_BUNDLES.get(locale);
  }

  try {
    const url = browserApi.runtime.getURL(`_locales/${locale}/messages.json`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load locale bundle: ${locale}`);
    }
    const bundle = await response.json();
    LANGUAGE_BUNDLES.set(locale, bundle);
    return bundle;
  } catch (err) {
    console.warn("Unable to load locale bundle", locale, err);
    LANGUAGE_BUNDLES.set(locale, null);
    return null;
  }
}

function getMessageFromBundle(locale, key, substitutions) {
  if (!locale || locale === "auto") {
    return null;
  }

  const bundle = LANGUAGE_BUNDLES.get(locale);
  if (!bundle) {
    return null;
  }

  const entry = bundle[key];
  if (!entry || typeof entry.message !== "string") {
    return null;
  }

  const rendered = renderMessage(entry.message, entry.placeholders, substitutions);
  return rendered || entry.message;
}

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9"
].map((name) => name.toLowerCase()));

const STORAGE_PRIMARY = browserApi?.storage?.sync || null;
const STORAGE_FALLBACK = browserApi?.storage?.local || null;

function storageGet(area) {
  if (!area) {
    return Promise.resolve({});
  }

  if (IS_CHROME) {
    return new Promise((resolve) => {
      try {
        area.get(null, (result) => {
          const err = chrome.runtime.lastError;
          if (err) {
            console.warn("storage.get failed", err);
            resolve({});
            return;
          }
          resolve(result || {});
        });
      } catch (err) {
        console.warn("storage.get threw", err);
        resolve({});
      }
    });
  }

  return area.get(null).catch((err) => {
    console.warn("storage.get failed", err);
    return {};
  });
}

function storageSet(area, values) {
  if (!area) {
    return Promise.resolve();
  }

  if (IS_CHROME) {
    return new Promise((resolve) => {
      try {
        area.set(values, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            console.warn("storage.set failed", err);
          }
          resolve();
        });
      } catch (err) {
        console.warn("storage.set threw", err);
        resolve();
      }
    });
  }

  return area.set(values).catch((err) => {
    console.warn("storage.set failed", err);
  });
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

function sanitizeRootFolder(value) {
  const candidate = (value || DEFAULT_SETTINGS.rootFolder)
    .toString()
    .normalize("NFKC")
    .slice(0, 80);
  return ensureSafePathSegment(candidate) || DEFAULT_SETTINGS.rootFolder;
}

function sanitizeSettings(raw = {}) {
  const merged = { ...DEFAULT_SETTINGS };

  merged.language = normalizeLanguage(raw.language);

  if (raw.range === "prompt" || raw.range === "custom" || raw.range === "all") {
    merged.range = raw.range;
  }

  merged.customRangeStart = clampNumber(raw.customRangeStart, 1, 9999, DEFAULT_SETTINGS.customRangeStart);
  merged.customRangeEnd = clampNumber(raw.customRangeEnd, merged.customRangeStart, 9999, Math.max(DEFAULT_SETTINGS.customRangeEnd, merged.customRangeStart));

  merged.antiTheft = raw.antiTheft !== false;
  merged.overlay = raw.overlay !== false;
  merged.rootFolder = sanitizeRootFolder(raw.rootFolder);
  merged.retryFailed = raw.retryFailed !== false;

  return merged;
}

let settingsReadyPromise = null;

async function loadSettingsFromStorage() {
  const syncValues = await storageGet(STORAGE_PRIMARY);
  const hasSyncValues = syncValues && Object.keys(syncValues).length > 0;
  if (hasSyncValues) {
    return sanitizeSettings(syncValues);
  }

  const localValues = await storageGet(STORAGE_FALLBACK);
  if (localValues && Object.keys(localValues).length > 0) {
    return sanitizeSettings(localValues);
  }

  return { ...DEFAULT_SETTINGS };
}

async function ensureSettingsLoaded() {
  if (!settingsReadyPromise) {
    settingsReadyPromise = (async () => {
      const settings = await loadSettingsFromStorage();
      currentSettings = settings;
      if (settings.language && settings.language !== DEFAULT_LANGUAGE) {
        await loadLocaleBundle(settings.language);
      }
      return currentSettings;
    })();
  }
  return settingsReadyPromise;
}

async function persistSettings(values) {
  const payload = { ...values };
  await storageSet(STORAGE_PRIMARY || STORAGE_FALLBACK, payload);
  if (STORAGE_PRIMARY && STORAGE_FALLBACK && STORAGE_PRIMARY !== STORAGE_FALLBACK) {
    await storageSet(STORAGE_FALLBACK, payload);
  }
}

async function broadcastSettings(settings) {
  try {
    const queryParams = { url: "https://www.pixiv.net/*" };
    const tabs = IS_CHROME
      ? await new Promise((resolve, reject) => {
          chrome.tabs.query(queryParams, (result) => {
            const err = chrome.runtime.lastError;
            if (err) {
              reject(new Error(err.message));
              return;
            }
            resolve(result || []);
          });
        })
      : await browserApi.tabs.query(queryParams);

    await Promise.all(
      (tabs || [])
        .filter((tab) => tab && tab.id)
        .map((tab) =>
          tabsSendMessage(tab.id, { type: "PIXIV_SETTINGS_PUSH", payload: settings }).catch(() => {})
        )
    );
  } catch (err) {
    console.warn("Failed to broadcast settings", err);
  }
}

async function updateSettings(partial, options = {}) {
  const sanitized = sanitizeSettings({ ...currentSettings, ...partial });
  const languageChanged = sanitized.language !== currentSettings.language;
  currentSettings = sanitized;

  if (languageChanged && sanitized.language && sanitized.language !== DEFAULT_LANGUAGE) {
    await loadLocaleBundle(sanitized.language);
  }

  if (options.persist !== false) {
    await persistSettings({
      language: sanitized.language,
      range: sanitized.range,
      customRangeStart: sanitized.customRangeStart,
      customRangeEnd: sanitized.customRangeEnd,
      antiTheft: sanitized.antiTheft,
      overlay: sanitized.overlay,
      rootFolder: sanitized.rootFolder,
      retryFailed: sanitized.retryFailed
    });
  }

  if (options.broadcast !== false) {
    await broadcastSettings(sanitized);
  }

  return sanitized;
}
function getMessage(key, substitutions) {
  if (currentSettings?.language && currentSettings.language !== DEFAULT_LANGUAGE) {
    const override = getMessageFromBundle(currentSettings.language, key, substitutions);
    if (override) {
      return override;
    }
  }

  try {
    if (browserApi?.i18n?.getMessage) {
      const localized = browserApi.i18n.getMessage(key, substitutions);
      if (localized) {
        return localized;
      }
    }
  } catch (err) {
    console.warn("i18n lookup failed", key, err);
  }

  const fallback = FALLBACK_MESSAGES[key];
  if (typeof fallback === "function") {
    return fallback(substitutions);
  }
  if (typeof fallback === "string") {
    return fallback;
  }
  return key;
}

function sanitizeSegment(segment, fallback) {
  const cleaned = (segment || "")
    .toString()
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/g, "")
    .trim();

  const candidate = cleaned.length === 0 ? `${fallback}` : cleaned.slice(0, 80);
  return ensureSafePathSegment(candidate);
}

function ensureSafePathSegment(value) {
  const normalized = (value || "")
    .toString()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/g, "")
    .trim();

  if (!normalized) {
    return "_";
  }

  const lower = normalized.toLowerCase();
  if (WINDOWS_RESERVED_NAMES.has(lower)) {
    return `${normalized}_`;
  }

  return normalized;
}

function truncateFilename(name, maxLength = 120) {
  if (!name) {
    return `file.${Date.now()}`;
  }

  if (name.length <= maxLength) {
    return name;
  }

  const dotIndex = name.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < name.length - 1) {
    const extension = name.slice(dotIndex);
    const baseLength = Math.max(1, maxLength - extension.length);
    return `${name.slice(0, baseLength)}${extension}`;
  }

  return name.slice(0, maxLength);
}

function ensureSafeFilename(name) {
  const trimmed = (name || "").toString().replace(/\.+$/g, "").trim();
  const dotIndex = trimmed.lastIndexOf(".");

  if (dotIndex > 0 && dotIndex < trimmed.length - 1) {
    const base = ensureSafePathSegment(trimmed.slice(0, dotIndex));
    const extension = trimmed.slice(dotIndex);
    return `${base}${extension}`;
  }

  return ensureSafePathSegment(trimmed);
}

function buildDownloadPathCandidates(meta, image, index, downloadUrl) {
  const sourceUrl = downloadUrl || image.url;
  const extension = getExtensionFromUrl(sourceUrl);
  const pageLabel = typeof image.page === "number" ? `p${String(image.page).padStart(2, "0")}_` : "";
  const safeAuthor = sanitizeSegment(meta.author, "Pixiv");
  const safeTitle = sanitizeSegment(meta.title, meta.illustId);
  const safeIllustId = ensureSafePathSegment(meta.illustId || "pixiv");
  const safeFolder = ensureSafePathSegment(`${safeIllustId}-${safeTitle}`);
  const simpleFolder = ensureSafePathSegment(`${safeIllustId}`);
  const safeRoot = ensureSafePathSegment(currentSettings.rootFolder || "Pixiv");

  const antiTheftEnabled = currentSettings.antiTheft !== false;
  const antiTheftTag = antiTheftEnabled ? "__pixiv-only" : "";
  const baseName = ensureSafeFilename(
    truncateFilename(`${pageLabel}${safeIllustId}_by_${safeAuthor}${antiTheftTag}.${extension}`, 120)
  );

  const originalName = extractFilenameFromUrl(sourceUrl) || `${safeIllustId}.${extension}`;
  const labeledOriginal = ensureSafeFilename(truncateFilename(`${pageLabel}${originalName}`, 120));
  const backupName = ensureSafeFilename(
    truncateFilename(`${pageLabel}${safeIllustId}.${extension}`, 120)
  );

  const fileNames = [baseName, labeledOriginal, backupName].filter(Boolean);
  const pathCandidates = new Set();

  const pathOptions = [
    [safeRoot, safeAuthor, safeFolder],
    [safeRoot, safeAuthor, simpleFolder],
    [safeRoot, simpleFolder],
    [safeRoot]
  ];

  for (const parts of pathOptions) {
    const filtered = parts.filter(Boolean);
    if (!filtered.length) {
      continue;
    }

    const basePath = filtered.join("/");
    for (const name of fileNames) {
      const candidate = `${basePath}/${name}`;
      if (candidate.length <= 240) {
        pathCandidates.add(candidate);
      }
    }
  }

  for (const name of fileNames) {
    if (name.length <= 240) {
      pathCandidates.add(name);
    }
  }

  if (pathCandidates.size === 0) {
    pathCandidates.add(`${safeIllustId || "pixiv"}_${Date.now()}.${extension}`);
  }

  return Array.from(pathCandidates);
}

function extractFilenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.split("/").filter(Boolean);
    return pathname[pathname.length - 1] || null;
  } catch (err) {
    return null;
  }
}

function getExtensionFromUrl(url) {
  const filename = extractFilenameFromUrl(url) || "";
  const match = filename.match(/\.([a-z0-9]+)(?:$|\?)/i);
  if (match) {
    return match[1].toLowerCase();
  }
  return "jpg";
}

function tabsQueryActive() {
  if (!IS_CHROME) {
    return browserApi.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0] || null);
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve((tabs && tabs[0]) || null);
    });
  });
}

function tabsSendMessage(tabId, message) {
  if (!IS_CHROME) {
    return browserApi.tabs.sendMessage(tabId, message);
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

function executeContentScript(tabId) {
  if (browserApi?.scripting && typeof browserApi.scripting.executeScript === "function") {
    const params = {
      target: { tabId },
      files: ["content/pixiv-scraper.js"]
    };

    if (!IS_CHROME) {
      return browserApi.scripting.executeScript(params).then(() => undefined);
    }

    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(params, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve();
      });
    });
  }

  if (browserApi?.tabs?.executeScript) {
    return new Promise((resolve, reject) => {
      try {
        browserApi.tabs.executeScript(tabId, { file: "content/pixiv-scraper.js" }, () => {
          const err = browserApi.runtime?.lastError || (typeof chrome !== "undefined" ? chrome.runtime?.lastError : undefined);
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  return Promise.resolve();
}

function downloadsDownload(options) {
  if (!IS_CHROME) {
    return browserApi.downloads.download(options);
  }

  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

function setBadgeText(tabId, text) {
  if (!actionApi || !tabId) {
    return;
  }

  try {
    const result = actionApi.setBadgeText({ tabId, text });
    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }
  } catch (err) {
    console.warn("Failed to set badge text", err);
  }
}

function setBadgeColor(tabId, color) {
  if (!actionApi || !tabId) {
    return;
  }

  try {
    const result = actionApi.setBadgeBackgroundColor({ tabId, color });
    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }
  } catch (err) {
    console.warn("Failed to set badge color", err);
  }
}

async function requestImagesFromTab(tabId) {
  try {
    return await tabsSendMessage(tabId, { type: "PIXIV_COLLECT_IMAGES" });
  } catch (err) {
    if (/Could not establish connection/i.test(err.message) || /Receiving end does not exist/i.test(err.message)) {
      await executeContentScript(tabId);
      return tabsSendMessage(tabId, { type: "PIXIV_COLLECT_IMAGES" });
    }
    throw err;
  }
}

const ACCEPTABLE_CONTENT_TYPES = [/^image\//i, /application\/zip/i];

async function fetchImageData(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    mode: "cors",
    referrer: "https://www.pixiv.net/"
  });

  if (!response.ok) {
    throw new Error(getMessage("errorDownloadImageFailed", String(response.status)));
  }

  const contentType = response.headers.get("content-type") || "";
  const isAcceptable = ACCEPTABLE_CONTENT_TYPES.some((pattern) => pattern.test(contentType));
  if (!isAcceptable) {
    throw new Error(`Unexpected content type: ${contentType || "unknown"}`);
  }

  const buffer = await response.arrayBuffer();
  return {
    arrayBuffer: buffer,
    contentType: contentType || "application/octet-stream",
    finalUrl: response.url || url
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function applyRangeSelection(images, selection) {
  if (!Array.isArray(images) || !images.length) {
    return [];
  }

  if (!selection || selection.mode !== "range") {
    return images.slice();
  }

  const total = images.length;
  const start = Math.min(total, Math.max(1, Math.floor(Number(selection.start) || 1)));
  const end = Math.min(total, Math.max(start, Math.floor(Number(selection.end) || total)));
  return images.slice(start - 1, end);
}

function getStoredRangeBounds(total) {
  const start = Math.min(total, Math.max(1, Math.floor(Number(currentSettings.customRangeStart) || 1)));
  const end = Math.min(total, Math.max(start, Math.floor(Number(currentSettings.customRangeEnd) || total)));
  return { start, end };
}

async function resolveSelectionForToolbar(tabId, meta) {
  const total = meta.images.length;
  if (total <= 1) {
    return { selection: { mode: "all" }, images: meta.images.slice() };
  }

  await ensureSettingsLoaded();

  if (currentSettings.range === "prompt") {
    const defaults = getStoredRangeBounds(total);
    const initialMode = defaults.start === 1 && defaults.end === total ? "all" : "range";

    try {
      const response = await tabsSendMessage(tabId, {
        type: "PIXIV_PROMPT_SELECTION",
        payload: {
          total,
          defaults: { ...defaults, mode: initialMode }
        }
      });

      if (!response || !response.success) {
        return { cancelled: true };
      }

      const selection = response.selection || { mode: "all" };
      if (selection.mode === "range") {
        const range = getStoredRangeBounds(total);
        const start = Math.min(total, Math.max(1, Math.floor(Number(selection.start) || range.start)));
        const end = Math.min(total, Math.max(start, Math.floor(Number(selection.end) || range.end)));
        return {
          selection: { mode: "range", start, end },
          images: applyRangeSelection(meta.images, { mode: "range", start, end })
        };
      }

      return { selection: { mode: "all" }, images: meta.images.slice() };
    } catch (err) {
      console.warn("Prompt selection failed", err);
      return { cancelled: true };
    }
  }

  if (currentSettings.range === "custom") {
    const range = getStoredRangeBounds(total);
    return {
      selection: { mode: "range", start: range.start, end: range.end },
      images: applyRangeSelection(meta.images, { mode: "range", start: range.start, end: range.end })
    };
  }

  return { selection: { mode: "all" }, images: meta.images.slice() };
}

async function triggerDownloads(meta) {
  const errors = [];

  if (meta?.selection && meta.selection.mode === "range") {
    const start = Number(meta.selection.start) || 1;
    const end = Number(meta.selection.end) || start;
    updateSettings(
      {
        customRangeStart: start,
        customRangeEnd: end
      },
      { persist: true, broadcast: true }
    ).catch(() => {});
  }

  for (let i = 0; i < meta.images.length; i += 1) {
    const image = meta.images[i];
    setBadgeText(meta.tabId, `${i + 1}/${meta.images.length}`);

    const candidates = [image.url, ...(Array.isArray(image.fallbacks) ? image.fallbacks : [])];
    const seen = new Set();
    let downloaded = false;
    let lastError = null;
    const maxAttempts = currentSettings.retryFailed === false ? 1 : 4;

    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const { arrayBuffer, contentType, finalUrl } = await fetchImageData(candidate);
          const base64 = arrayBufferToBase64(arrayBuffer);
          const dataUrl = `data:${contentType};base64,${base64}`;
          const pathCandidates = buildDownloadPathCandidates(meta, image, i, finalUrl);

          let savedWithPath = false;
          let pathError = null;

          for (const path of pathCandidates) {
            try {
              await downloadsDownload({
                url: dataUrl,
                filename: path,
                conflictAction: "uniquify",
                saveAs: false
              });
              savedWithPath = true;
              break;
            } catch (downloadErr) {
              pathError = downloadErr;
              const message = (downloadErr?.message || "").toLowerCase();
              if (message.includes("invalid filename") || message.includes("path too long")) {
                continue;
              }
              break;
            }
          }

          if (savedWithPath) {
            downloaded = true;
            break;
          }

          lastError = pathError || lastError;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
            continue;
          }
        }
      }

      if (downloaded) {
        break;
      }
    }

    if (!downloaded) {
      const message = lastError?.message || getMessage("errorDownloadImageFailed", "?");
      console.error("Failed to download", image.url, message, lastError);
      errors.push({ url: image.url, error: message });
    }
  }

  return errors;
}

function formatErrorMessage(message) {
  if (!message) return getMessage("errorUnknown");
  if (message.length < 120) return message;
  return `${message.slice(0, 117)}...`;
}

function finalizeBadge(tabId, totalCount, errorCount) {
  if (!tabId) {
    return;
  }

  if (errorCount === 0) {
    setBadgeText(tabId, "✔");
  } else if (errorCount >= totalCount) {
    setBadgeText(tabId, "ERR");
  } else {
    setBadgeText(tabId, `${totalCount - errorCount}`);
  }

  setTimeout(() => setBadgeText(tabId, ""), 2500);
}

async function handleAction(tab) {
  const targetTab = tab && tab.id ? tab : await tabsQueryActive();
  if (!targetTab || !targetTab.id) {
    return;
  }

  setBadgeColor(targetTab.id, "#1d9bf0");

  if (!targetTab.url || !/^https?:\/\/(www\.)?pixiv\.net\//i.test(targetTab.url)) {
    setBadgeText(targetTab.id, "N/A");
    setTimeout(() => setBadgeText(targetTab.id, ""), 2000);
    return;
  }

  setBadgeText(targetTab.id, "...");

  let payload;
  try {
    payload = await requestImagesFromTab(targetTab.id);
  } catch (err) {
    console.error("Messaging error", err);
    setBadgeText(targetTab.id, "ERR");
    setTimeout(() => setBadgeText(targetTab.id, ""), 2000);
    return;
  }

  if (!payload || !payload.success || !Array.isArray(payload.images) || !payload.images.length) {
    const reason = payload && payload.error ? payload.error : getMessage("errorNoDownloadableImages");
    console.warn("Pixiv scrape failed", reason);
    setBadgeText(targetTab.id, "0");
    setTimeout(() => setBadgeText(targetTab.id, ""), 2000);
    return;
  }

  const meta = {
    tabId: targetTab.id,
    illustId: payload.illustId,
    title: payload.title,
    author: payload.author,
    images: payload.images
  };

  await ensureSettingsLoaded();
  const selectionResult = await resolveSelectionForToolbar(targetTab.id, meta);

  if (selectionResult.cancelled) {
    setBadgeText(targetTab.id, "");
    return;
  }

  if (!selectionResult.images || selectionResult.images.length === 0) {
    setBadgeText(targetTab.id, "0");
    setTimeout(() => setBadgeText(targetTab.id, ""), 2000);
    return;
  }

  const downloadMeta = {
    ...meta,
    images: selectionResult.images,
    selection: selectionResult.selection || { mode: "all" }
  };

  const errors = await triggerDownloads(downloadMeta);
  finalizeBadge(targetTab.id, selectionResult.images.length, errors.length);
}

ensureSettingsLoaded().catch((err) => {
  console.warn("Failed to load initial settings", err);
});

if (actionApi?.onClicked && typeof actionApi.onClicked.addListener === "function") {
  actionApi.onClicked.addListener(handleAction);
}

browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return;
  }

  if (message.type === "PIXIV_DOWNLOAD_SELECTION") {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: getMessage("errorActiveTabMissing") });
      return true;
    }

    const payload = message.payload || {};
    if (!Array.isArray(payload.images) || payload.images.length === 0) {
      sendResponse({ success: false, error: getMessage("errorNoImagesForDownload") });
      return true;
    }

    const meta = {
      tabId,
      illustId: payload.illustId || "pixiv",
      title: payload.title || getMessage("fallbackArtworkTitle", payload.illustId || ""),
      author: payload.author || getMessage("fallbackUnknownCreator"),
      images: payload.images,
      selection: payload.selection || { mode: "all" }
    };

    setBadgeColor(tabId, "#1d9bf0");
    setBadgeText(tabId, "...");

    (async () => {
      try {
        await ensureSettingsLoaded();
        const errors = await triggerDownloads(meta);
        finalizeBadge(tabId, meta.images.length, errors.length);
        sendResponse({ success: true, accepted: true, count: meta.images.length, errors });
      } catch (err) {
        console.error("Pixiv overlay-triggered download failed", err);
        setBadgeText(tabId, "ERR");
        setTimeout(() => setBadgeText(tabId, ""), 2500);
        sendResponse({ success: false, error: formatErrorMessage(err?.message) });
      }
    })();
    return true;
  }

  if (message.type === "PIXIV_SETTINGS_UPDATED") {
    (async () => {
      try {
        await ensureSettingsLoaded();
        const sanitized = await updateSettings(message.payload || {}, { persist: true, broadcast: true });
        sendResponse({ success: true, settings: sanitized });
      } catch (err) {
        console.error("Failed to apply updated settings", err);
        sendResponse({ success: false, error: err?.message || "settings-error" });
      }
    })();
    return true;
  }

  if (message.type === "PIXIV_SETTINGS_REQUEST") {
    (async () => {
      try {
        const settings = await ensureSettingsLoaded();
        sendResponse({ success: true, settings });
      } catch (err) {
        sendResponse({ success: false, error: err?.message || "settings-error" });
      }
    })();
    return true;
  }
});
