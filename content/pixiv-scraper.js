(() => {
  const browserApi = typeof browser !== "undefined" ? browser : chrome;
  const IS_CHROME = typeof browser === "undefined";

  const STYLE_ID = "pixiv-bulk-style";
  const HOST_ATTR = "data-pixiv-bulk-host";
  const WRAPPER_CLASS = "pixiv-bulk-overlay";
  const BUTTON_CLASS = "pixiv-bulk-trigger";
  const TOAST_ID = "pixiv-bulk-toast";

  const FALLBACK_MESSAGES = {
    overlayAriaLabel: "Download Pixiv images",
    dialogTitle: "Download images",
    dialogSummary: (count) => {
      const value = Array.isArray(count) ? count[0] : count;
      return `Found ${value ?? ""} images. All are selected by default.`;
    },
    dialogOptionAll: "All images",
    dialogOptionRange: "Specific range",
    dialogErrorInvalidNumbers: "Please enter valid numbers.",
    dialogErrorRangeOrder: "Start value must be less than or equal to end.",
    dialogButtonCancel: "Cancel",
    dialogButtonConfirm: "Download",
    toastRangeEmpty: "The selected range contains no images.",
    toastDownloadStartFailed: "The download couldn’t be started.",
    toastDownloadingCount: (count) => {
      const value = Array.isArray(count) ? count[0] : count;
      return `Downloading ${value ?? ""} images...`;
    },
    errorMissingPreload: "Pixiv preload metadata is missing.",
    errorParsePreload: (error) => {
      const value = Array.isArray(error) ? error[0] : error;
      return `Failed to parse Pixiv metadata: ${value ?? ""}`;
    },
    errorNoIllustrationData: "The current page does not expose illustration data.",
    errorNoDownloadableImages: "No downloadable images were found on this artwork.",
    errorUnsupportedPage: "This extension only supports Pixiv artwork detail pages.",
    errorDataFetchFailed: "Pixiv data could not be retrieved.",
    errorPixivRequestFailed: (status) => {
      const value = Array.isArray(status) ? status[0] : status;
      return `Pixiv request failed (${value ?? "?"}).`;
    },
    errorPixivResponse: "Pixiv returned an error.",
    errorNoAjaxBody: "Pixiv illustration data was not found.",
    fallbackArtworkTitle: (illustId) => {
      const value = Array.isArray(illustId) ? illustId[0] : illustId;
      return `Pixiv Artwork ${value ?? ""}`;
    },
    fallbackUnknownCreator: "Unknown Creator"
  };

  const SUPPORTED_LANGUAGES = new Set(["en", "ja", "zh_CN"]);
  const DEFAULT_LANGUAGE = "en";

  function normalizeLanguage(value) {
    if (!value || value === "auto") {
      return DEFAULT_LANGUAGE;
    }
    if (SUPPORTED_LANGUAGES.has(value)) {
      return value;
    }
    return DEFAULT_LANGUAGE;
  }

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

  let extensionSettings = { ...DEFAULT_SETTINGS };
  const localeBundles = new Map();

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

  async function ensureLocaleBundle(locale) {
    if (!locale || locale === "auto") {
      return null;
    }

    if (localeBundles.has(locale)) {
      return localeBundles.get(locale);
    }

    try {
      const url = browserApi.runtime.getURL(`_locales/${locale}/messages.json`);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to load locale bundle: ${locale}`);
      }
      const json = await response.json();
      localeBundles.set(locale, json);
      return json;
    } catch (err) {
      console.warn("Unable to load locale bundle", locale, err);
      localeBundles.set(locale, null);
      return null;
    }
  }

  function getMessageFromBundle(locale, key, substitutions) {
    if (!locale || locale === "auto") {
      return null;
    }

    const bundle = localeBundles.get(locale);
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

  function t(key, substitutions) {
    if (extensionSettings.language && extensionSettings.language !== DEFAULT_LANGUAGE) {
      const override = getMessageFromBundle(extensionSettings.language, key, substitutions);
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

  let overlayWrapper = null;
  let overlayButton = null;
  let overlayHost = null;
  let mutationObserver = null;
  let attachScheduled = false;
  let pathWatcher = null;
  let toastTimer = null;

  let cachedIllustId = null;
  let cachedPayload = null;
  let inflightPromise = null;
  let inflightIllustId = null;

  function runtimeSendMessage(message) {
    if (!IS_CHROME) {
      return browserApi.runtime.sendMessage(message);
    }

    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function getIllustId() {
    const match = window.location.pathname.match(/artworks\/(\d+)/);
    return match ? match[1] : null;
  }

  function applySettingsPatch(patch) {
    if (!patch || typeof patch !== "object") {
      return;
    }

    const previous = extensionSettings;
    const previousLanguage = normalizeLanguage(previous.language);
    const normalizedPatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "language")) {
      normalizedPatch.language = normalizeLanguage(normalizedPatch.language);
    }

    extensionSettings = { ...extensionSettings, ...normalizedPatch };
    extensionSettings.language = normalizeLanguage(extensionSettings.language);

    const languageChanged = extensionSettings.language !== previousLanguage;
    if (languageChanged) {
      if (extensionSettings.language && extensionSettings.language !== DEFAULT_LANGUAGE) {
        ensureLocaleBundle(extensionSettings.language).then(() => {
          if (overlayButton) {
            overlayButton.setAttribute("aria-label", t("overlayAriaLabel"));
          }
          scheduleAttach();
        });
      } else {
        if (overlayButton) {
          overlayButton.setAttribute("aria-label", t("overlayAriaLabel"));
        }
        scheduleAttach();
      }
    }

    if (extensionSettings.overlay === false && previous.overlay !== false) {
      detachButton();
    } else if (extensionSettings.overlay !== false && previous.overlay === false) {
      scheduleAttach();
    }
  }

  async function fetchAndApplySettings() {
    try {
      const response = await runtimeSendMessage({ type: "PIXIV_SETTINGS_REQUEST" });
      if (response && response.success && response.settings) {
        applySettingsPatch(response.settings);
        if (
          extensionSettings.language &&
          extensionSettings.language !== DEFAULT_LANGUAGE &&
          !localeBundles.has(extensionSettings.language)
        ) {
          await ensureLocaleBundle(extensionSettings.language);
        }
      }
    } catch (err) {
      console.warn("Failed to synchronize extension settings", err);
    }
  }

  function parsePreloadData() {
    const meta = document.querySelector("meta#meta-preload-data");
    if (!meta) {
      return { error: t("errorMissingPreload") };
    }

    try {
      const json = JSON.parse(meta.content || meta.getAttribute("content") || "{}");
      return { data: json };
    } catch (err) {
      return { error: t("errorParsePreload", err.message || "") };
    }
  }

  function dedupeUrls(items) {
    const map = new Map();

    for (const item of items) {
      if (!item || !item.url) continue;
      const key = item.url;
      const fallbacks = Array.isArray(item.fallbacks) ? item.fallbacks.filter(Boolean) : [];

      if (!map.has(key)) {
        map.set(key, {
          ...item,
          fallbacks: [...new Set(fallbacks)]
        });
      } else if (fallbacks.length) {
        const existing = map.get(key);
        const seenFallbacks = new Set(existing.fallbacks || []);
        for (const candidate of fallbacks) {
          if (!candidate || seenFallbacks.has(candidate)) {
            continue;
          }
          seenFallbacks.add(candidate);
          existing.fallbacks = existing.fallbacks || [];
          existing.fallbacks.push(candidate);
        }
      }
    }

    return Array.from(map.values());
  }

  function buildMasterCandidates(url) {
    if (!url || !url.includes("/img-original/")) {
      return [];
    }

    const match = url.match(/_p(\d+)(\.[^.]+)$/i);
    if (!match) {
      return [];
    }

    const pageIndex = match[1];
    const extension = match[2];
    const base = url
      .replace("/img-original/", "/img-master/")
      .replace(`_p${pageIndex}${extension}`, `_p${pageIndex}_master1200`);

    const candidates = [`${base}.jpg`];
    if (extension.toLowerCase() !== ".jpg") {
      candidates.push(`${base}${extension}`);
    }

    return candidates;
  }

  function buildFallbackList(primary, extras) {
    const seen = new Set([primary]);
    const result = [];

    for (const candidate of extras || []) {
      if (!candidate || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      result.push(candidate);
    }

    for (const masterCandidate of buildMasterCandidates(primary)) {
      if (!seen.has(masterCandidate)) {
        seen.add(masterCandidate);
        result.push(masterCandidate);
      }
    }

    return result;
  }

  function collectIllustImages(illustId, data) {
    const illustEntry = data?.illust?.[illustId] || null;
    const mangaEntry = data?.illustManga?.[illustId] || null;
    const ugoiraEntry = data?.ugoira?.[illustId] || null;

    if (!illustEntry && !mangaEntry && !ugoiraEntry) {
      return {
        success: false,
        error: t("errorNoIllustrationData")
      };
    }

    const title = illustEntry?.title || mangaEntry?.title || t("fallbackArtworkTitle", illustId);
    const author = illustEntry?.userName || mangaEntry?.userName || t("fallbackUnknownCreator");

    const images = [];
    const pushOriginal = (url, pageIndex, variant, extraFallbacks = []) => {
      if (!url) return;
      const fallbacks = buildFallbackList(url, Array.isArray(extraFallbacks) ? extraFallbacks : [extraFallbacks]);
      images.push({ url, page: pageIndex, variant, fallbacks });
    };

    if (illustEntry?.urls?.original) {
      const extra = [
        illustEntry.urls.regular,
        illustEntry.urls.small,
        illustEntry.urls.thumb,
        illustEntry.urls.mini
      ];
      pushOriginal(illustEntry.urls.original, 0, "original", extra);
    }

    if (mangaEntry?.pages?.length) {
      mangaEntry.pages.forEach((page, index) => {
        const original = page?.urls?.original || page?.urls?.regular || null;
        const extra = [
          page?.urls?.regular,
          page?.urls?.small,
          page?.urls?.thumb
        ];
        pushOriginal(original, index, "page", extra);
      });
    }

    if (illustEntry?.pageCount > 1 && !mangaEntry?.pages?.length) {
      for (let i = 0; i < illustEntry.pageCount; i += 1) {
        const guess = illustEntry.urls?.original?.replace(/_p0(\.[^./]+)$/i, `_p${i}$1`);
        pushOriginal(guess, i, "guessed");
      }
    }

    if (ugoiraEntry?.originalSrc) {
      pushOriginal(ugoiraEntry.originalSrc, 0, "ugoira");
    }

    const uniqueImages = dedupeUrls(images);
    if (!uniqueImages.length) {
      return {
        success: false,
        error: t("errorNoDownloadableImages")
      };
    }

    return {
      success: true,
      illustId,
      title,
      author,
      images: uniqueImages
    };
  }

  async function fetchPixivJson(url) {
    const response = await fetch(url, {
      credentials: "include",
      referrer: "https://www.pixiv.net/",
      mode: "cors",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(t("errorPixivRequestFailed", String(response.status)));
    }

    const json = await response.json();
    if (json && json.error) {
      throw new Error(json.message || t("errorPixivResponse"));
    }

    return json;
  }

  async function fetchIllustAjax(illustId) {
    return fetchPixivJson(`https://www.pixiv.net/ajax/illust/${illustId}?lang=en`);
  }

  async function fetchUgoiraMeta(illustId) {
    return fetchPixivJson(`https://www.pixiv.net/ajax/illust/${illustId}/ugoira_meta`);
  }

  function convertAjaxToPreload(illustId, body, ugoiraMeta) {
    const illust = {};
    const illustManga = {};
    const ugoira = {};

    const title = body?.title || `Pixiv Artwork ${illustId}`;
    const author = body?.userName || body?.userAccount || "Unknown Creator";
    const urls = body?.urls || {};
    const pageCount = Number(body?.pageCount || (Array.isArray(body?.mangaPages) ? body.mangaPages.length : 1));

    illust[illustId] = {
      title,
      userName: author,
      urls,
      pageCount
    };

    if (Array.isArray(body?.mangaPages) && body.mangaPages.length) {
      illustManga[illustId] = {
        title,
        userName: author,
        pages: body.mangaPages.map((page) => ({ urls: page?.urls || {} }))
      };
    }

    const ugoiraBody = ugoiraMeta?.body || ugoiraMeta || null;
    const ugoiraSrc = ugoiraBody?.originalSrc || ugoiraBody?.src || ugoiraBody?.zipUrls?.medium || null;

    if (ugoiraSrc) {
      ugoira[illustId] = { originalSrc: ugoiraSrc };
    }

    return { illust, illustManga, ugoira };
  }

  async function buildResultFromAjax(illustId) {
    const ajaxJson = await fetchIllustAjax(illustId);
    const body = ajaxJson?.body;

    if (!body) {
      throw new Error(t("errorNoAjaxBody"));
    }

    let ugoiraMeta = null;
    if (Number(body.illustType) === 2) {
      try {
        ugoiraMeta = await fetchUgoiraMeta(illustId);
      } catch (err) {
        console.warn("Failed to fetch Pixiv ugoira metadata", err);
      }
    }

    const normalized = convertAjaxToPreload(illustId, body, ugoiraMeta);
    const result = collectIllustImages(illustId, normalized);
    if (!result.success) {
      throw new Error(result.error || t("errorNoDownloadableImages"));
    }
    return result;
  }

  async function collectPixivMedia() {
    const illustId = getIllustId();
    if (!illustId) {
      return {
        success: false,
        error: t("errorUnsupportedPage")
      };
    }

    if (cachedIllustId === illustId && cachedPayload) {
      return cachedPayload;
    }

    if (inflightPromise && inflightIllustId === illustId) {
      try {
        const inflightResult = await inflightPromise;
        if (inflightResult.success) {
          cachedIllustId = illustId;
          cachedPayload = inflightResult;
        }
        return inflightResult;
      } catch (err) {
        return { success: false, error: err?.message || t("errorDataFetchFailed") };
      }
    }

    const promise = (async () => {
      const { data } = parsePreloadData();
      if (data) {
        const metaResult = collectIllustImages(illustId, data);
        if (metaResult.success) {
          return metaResult;
        }
      }

      return buildResultFromAjax(illustId);
    })();

    inflightIllustId = illustId;
    inflightPromise = promise;

    try {
      const result = await promise;
      if (result.success) {
        cachedIllustId = illustId;
        cachedPayload = result;
      }
      return result;
    } catch (err) {
      return { success: false, error: err?.message || t("errorDataFetchFailed") };
    } finally {
      if (inflightIllustId === illustId) {
        inflightIllustId = null;
        inflightPromise = null;
      }
    }
  }

  function ensureStylesInjected() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
[${HOST_ATTR}="true"] {
  position: relative !important;
}
.${WRAPPER_CLASS} {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 2147483645;
  pointer-events: none;
}
.${BUTTON_CLASS} {
  pointer-events: auto;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1d9bf0;
  color: #fff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.2s ease;
  font-size: 0;
}
.${BUTTON_CLASS}:hover {
  transform: scale(1.06);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  background: #0d6efd;
}
.${BUTTON_CLASS}:focus-visible {
  outline: 3px solid rgba(13, 110, 253, 0.35);
  outline-offset: 2px;
}
.${BUTTON_CLASS} svg {
  width: 22px;
  height: 22px;
  fill: currentColor;
}
.${BUTTON_CLASS}.pixiv-bulk-busy svg {
  animation: pixiv-bulk-spin 0.9s linear infinite;
}
@keyframes pixiv-bulk-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.pixiv-bulk-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483646;
  animation: pixiv-bulk-fade-in 0.18s ease;
}
@keyframes pixiv-bulk-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.pixiv-bulk-dialog {
  background: #111827;
  color: #f8fafc;
  max-width: 360px;
  width: calc(100% - 48px);
  border-radius: 16px;
  padding: 24px 24px 20px;
  font-family: "Segoe UI", "Helvetica Neue", sans-serif;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
}
.pixiv-bulk-dialog h2 {
  font-size: 18px;
  margin: 0 0 8px;
}
.pixiv-bulk-dialog p {
  margin: 0 0 16px;
  font-size: 13px;
  color: #cbd5f5;
}
.pixiv-bulk-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
  font-size: 14px;
}
.pixiv-bulk-option input[type="radio"] {
  margin-top: 2px;
}
.pixiv-bulk-range-inputs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  margin-left: 26px;
}
.pixiv-bulk-range-inputs input[type="number"] {
  width: 72px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.4);
  background: rgba(30, 41, 59, 0.8);
  color: #f8fafc;
  font-size: 14px;
}
.pixiv-bulk-range-inputs span {
  color: #94a3b8;
}
.pixiv-bulk-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
}
.pixiv-bulk-dialog-actions button {
  min-width: 96px;
  padding: 8px 14px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
}
.pixiv-bulk-cancel {
  background: rgba(148, 163, 184, 0.25);
  color: #e2e8f0;
}
.pixiv-bulk-cancel:hover {
  background: rgba(148, 163, 184, 0.4);
}
.pixiv-bulk-confirm {
  background: #1d9bf0;
  color: #fff;
}
.pixiv-bulk-confirm:hover {
  background: #0d6efd;
}
.pixiv-bulk-dialog .pixiv-bulk-error {
  color: #f87171;
  font-size: 13px;
  margin-top: 6px;
  min-height: 18px;
}
.pixiv-bulk-toast {
  position: fixed;
  left: 50%;
  top: 24px;
  transform: translate(-50%, -8px);
  background: rgba(15, 23, 42, 0.92);
  color: #f8fafc;
  padding: 10px 16px;
  border-radius: 999px;
  font-size: 13px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  z-index: 2147483647;
  opacity: 0;
  animation: pixiv-bulk-toast-in 0.2s forwards ease;
}
.pixiv-bulk-toast--error {
  background: rgba(185, 28, 28, 0.92);
}
.pixiv-bulk-toast--success {
  background: rgba(22, 163, 74, 0.92);
}
@keyframes pixiv-bulk-toast-in {
  from { opacity: 0; transform: translate(-50%, -12px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}`;
    document.head.appendChild(style);
  }

  function ensureHostPosition(element) {
    if (!element) return;
    const computed = window.getComputedStyle(element);
    if (computed.position === "static" && !element.dataset.pixivBulkPrevPosition) {
      element.dataset.pixivBulkPrevPosition = element.style.position || "";
      element.style.position = "relative";
    }
    element.setAttribute(HOST_ATTR, "true");
  }

  function restoreHostPosition(element) {
    if (!element) return;
    element.removeAttribute(HOST_ATTR);
    if (Object.prototype.hasOwnProperty.call(element.dataset, "pixivBulkPrevPosition")) {
      const prev = element.dataset.pixivBulkPrevPosition;
      element.style.position = prev;
      delete element.dataset.pixivBulkPrevPosition;
    }
  }

  function isElementVisible(el) {
    if (!el || el.hidden) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return rect.bottom > 0 && rect.top < (window.innerHeight || document.documentElement.clientHeight);
  }

  function findPrimaryImageContainer() {
    const candidates = document.querySelectorAll('main img[src*="i.pximg.net"]');
    for (const img of candidates) {
      if (!isElementVisible(img)) continue;
      const host =
        img.closest('figure, div[data-testid="illust-detail-image"], div[data-type="illust"], div[class*="sc-"]') ||
        img.parentElement;
      if (host && isElementVisible(host)) {
        return host;
      }
    }
    return null;
  }

  function createOverlayButton() {
    ensureStylesInjected();
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.setAttribute("aria-label", t("overlayAriaLabel"));
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3a7 7 0 00-7 7h2a5 5 0 0110 0h2a7 7 0 00-7-7zm-6 8h2l4 4 4-4h2l-6 6-6-6zm-1 3h2v5h12v-5h2v7H5z"/></svg>';
    return button;
  }

  function detachButton() {
    if (overlayButton) {
      overlayButton.removeEventListener("click", handleOverlayClick);
    }
    if (overlayWrapper && overlayWrapper.parentElement) {
      overlayWrapper.parentElement.removeChild(overlayWrapper);
    }
    if (overlayHost) {
      restoreHostPosition(overlayHost);
    }
    overlayWrapper = null;
    overlayButton = null;
    overlayHost = null;
  }

  function attachButtonIfNeeded() {
    if (extensionSettings.overlay === false) {
      detachButton();
      return;
    }

    const illustId = getIllustId();
    if (!illustId) {
      detachButton();
      cachedIllustId = null;
      cachedPayload = null;
      return;
    }

    const container = findPrimaryImageContainer();
    if (!container) {
      detachButton();
      return;
    }

    if (overlayHost && overlayHost !== container) {
      detachButton();
    }

    if (overlayButton) {
      return;
    }

    ensureStylesInjected();
    ensureHostPosition(container);

    overlayHost = container;
    overlayWrapper = document.createElement("div");
    overlayWrapper.className = WRAPPER_CLASS;
    overlayButton = createOverlayButton();
    overlayWrapper.appendChild(overlayButton);
    container.appendChild(overlayWrapper);
    overlayButton.addEventListener("click", handleOverlayClick);
  }

  function scheduleAttach() {
    if (attachScheduled) {
      return;
    }

    attachScheduled = true;
    requestAnimationFrame(() => {
      attachScheduled = false;
      try {
        attachButtonIfNeeded();
      } catch (err) {
        console.error("Pixiv bulk button attach failed", err);
      }
    });
  }

  function showToast(message, variant = "info") {
    if (!message) return;
    ensureStylesInjected();

    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }

    const existing = document.getElementById(TOAST_ID);
    if (existing) {
      existing.remove();
    }

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.className = "pixiv-bulk-toast";
    if (variant === "error") {
      toast.classList.add("pixiv-bulk-toast--error");
    } else if (variant === "success") {
      toast.classList.add("pixiv-bulk-toast--success");
    }
    toast.textContent = message;
    document.body.appendChild(toast);

    toastTimer = setTimeout(() => {
      toast.style.transition = "opacity 0.25s ease, transform 0.25s ease";
      toast.style.opacity = "0";
      toast.style.transform = "translate(-50%, -16px)";
      setTimeout(() => {
        toast.remove();
      }, 280);
    }, 3200);
  }

  function setButtonBusy(state) {
    if (!overlayButton) return;
    overlayButton.classList.toggle("pixiv-bulk-busy", Boolean(state));
    overlayButton.disabled = Boolean(state);
  }

  function applySelection(images, selection) {
    if (!selection || selection.mode !== "range") {
      return images.slice();
    }

    const total = images.length;
    const startIndex = Math.max(0, Math.min(total - 1, (selection.start || 1) - 1));
    const endIndex = Math.max(startIndex, Math.min(total - 1, (selection.end || total) - 1));
    return images.slice(startIndex, endIndex + 1);
  }

  function getStoredRangeBounds(total) {
    const start = Math.min(total, Math.max(1, Math.floor(Number(extensionSettings.customRangeStart) || 1)));
    const end = Math.min(total, Math.max(start, Math.floor(Number(extensionSettings.customRangeEnd) || total)));
    return { start, end };
  }

  function promptSelection(meta, defaults = {}) {
    ensureStylesInjected();

    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "pixiv-bulk-dialog-backdrop";

      const dialog = document.createElement("div");
      dialog.className = "pixiv-bulk-dialog";
      dialog.innerHTML = `
        <h2>${t("dialogTitle")}</h2>
        <p>${t("dialogSummary", meta.images.length.toString())}</p>
        <label class="pixiv-bulk-option">
          <input type="radio" name="pixiv-bulk-mode" value="all" checked />
          <span>${t("dialogOptionAll")}</span>
        </label>
        <label class="pixiv-bulk-option">
          <input type="radio" name="pixiv-bulk-mode" value="range" />
          <span>${t("dialogOptionRange")}</span>
        </label>
        <div class="pixiv-bulk-range-inputs">
          <input type="number" class="pixiv-bulk-range-start" min="1" max="${meta.images.length}" value="1" />
          <span>–</span>
          <input type="number" class="pixiv-bulk-range-end" min="1" max="${meta.images.length}" value="${meta.images.length}" />
        </div>
        <div class="pixiv-bulk-error" aria-live="assertive"></div>
        <div class="pixiv-bulk-dialog-actions">
          <button type="button" class="pixiv-bulk-cancel">${t("dialogButtonCancel")}</button>
          <button type="button" class="pixiv-bulk-confirm">${t("dialogButtonConfirm")}</button>
        </div>
      `;

      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);

      const startInput = dialog.querySelector(".pixiv-bulk-range-start");
      const endInput = dialog.querySelector(".pixiv-bulk-range-end");
      const errorEl = dialog.querySelector(".pixiv-bulk-error");
      const radioAll = dialog.querySelector('input[value="all"]');
      const radioRange = dialog.querySelector('input[value="range"]');

      const total = meta.images.length;
      const defaultStart = Math.min(total, Math.max(1, Math.floor(Number(defaults.start) || 1)));
      const defaultEnd = Math.min(total, Math.max(defaultStart, Math.floor(Number(defaults.end) || total)));
      const defaultMode = defaults.mode === "range" && total > 1 ? "range" : "all";

      startInput.value = defaultStart.toString();
      endInput.value = defaultEnd.toString();

      if (defaultMode === "range") {
        radioRange.checked = true;
        radioAll.checked = false;
      }

      function updateRangeDisabled() {
        const isRange = radioRange.checked;
        startInput.disabled = !isRange;
        endInput.disabled = !isRange;
        if (!isRange) {
          errorEl.textContent = "";
        }
      }

      updateRangeDisabled();

      radioAll.addEventListener("change", updateRangeDisabled);
      radioRange.addEventListener("change", updateRangeDisabled);

      function cleanup(result) {
        document.removeEventListener("keydown", onKeyDown, true);
        backdrop.remove();
        resolve(result || null);
      }

      function onKeyDown(evt) {
        if (evt.key === "Escape") {
          evt.preventDefault();
          cleanup(null);
        } else if (evt.key === "Enter" && evt.target.tagName !== "TEXTAREA") {
          evt.preventDefault();
          handleConfirm();
        }
      }

      document.addEventListener("keydown", onKeyDown, true);

      function handleConfirm() {
        if (radioAll.checked) {
          cleanup({ mode: "all" });
          return;
        }

        const start = Number(startInput.value);
        const end = Number(endInput.value);
        if (Number.isNaN(start) || Number.isNaN(end)) {
          errorEl.textContent = t("dialogErrorInvalidNumbers");
          return;
        }

        const min = 1;
        const max = meta.images.length;
        const clampedStart = Math.min(Math.max(start, min), max);
        const clampedEnd = Math.min(Math.max(end, min), max);

        if (clampedStart > clampedEnd) {
          errorEl.textContent = t("dialogErrorRangeOrder");
          return;
        }

        cleanup({ mode: "range", start: clampedStart, end: clampedEnd });
      }

      dialog.querySelector(".pixiv-bulk-confirm").addEventListener("click", handleConfirm);
      dialog.querySelector(".pixiv-bulk-cancel").addEventListener("click", () => cleanup(null));
      backdrop.addEventListener("click", (evt) => {
        if (evt.target === backdrop) {
          cleanup(null);
        }
      });

      if (radioRange.checked) {
        startInput.focus({ preventScroll: true });
      } else if (radioAll) {
        radioAll.focus({ preventScroll: true });
      }
    });
  }

  async function handleOverlayClick(event) {
    event.preventDefault();
    setButtonBusy(true);

    try {
      const result = await collectPixivMedia();
      setButtonBusy(false);

      if (!result.success) {
        showToast(result.error || t("errorDataFetchFailed"), "error");
        return;
      }

      let selection = { mode: "all" };
      const total = result.images.length;
      const forcePrompt = event?.shiftKey;

      if (total > 1) {
        if (forcePrompt || extensionSettings.range === "prompt") {
          const defaults = getStoredRangeBounds(total);
          const defaultMode = forcePrompt ? "range" : extensionSettings.range === "custom" ? "range" : "all";
          selection = await promptSelection(result, {
            mode: defaultMode,
            start: defaults.start,
            end: defaults.end
          });
          if (!selection) {
            return;
          }
        } else if (extensionSettings.range === "custom") {
          const bounds = getStoredRangeBounds(total);
          selection = { mode: "range", start: bounds.start, end: bounds.end };
        }
      }

      const filteredImages = applySelection(result.images, selection);
      if (!filteredImages.length) {
        showToast(t("toastRangeEmpty"), "error");
        return;
      }

      if (selection.mode === "range") {
        applySettingsPatch({ customRangeStart: selection.start, customRangeEnd: selection.end });
      }

      setButtonBusy(true);
      const payload = {
        illustId: result.illustId,
        title: result.title,
        author: result.author,
        images: filteredImages,
        selection
      };

      await runtimeSendMessage({ type: "PIXIV_DOWNLOAD_SELECTION", payload });
      showToast(t("toastDownloadingCount", filteredImages.length.toString()), "success");
    } catch (err) {
      console.error("Pixiv bulk download failed", err);
      showToast(err?.message || t("toastDownloadStartFailed"), "error");
    } finally {
      setButtonBusy(false);
    }
  }

  function initOverlay() {
    if (mutationObserver) {
      return;
    }

    mutationObserver = new MutationObserver(() => scheduleAttach());
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("scroll", scheduleAttach, { passive: true });
    window.addEventListener("resize", scheduleAttach, { passive: true });

    let lastPathname = window.location.pathname;
    pathWatcher = setInterval(() => {
      if (window.location.pathname !== lastPathname) {
        lastPathname = window.location.pathname;
        cachedIllustId = null;
        cachedPayload = null;
        detachButton();
        scheduleAttach();
      }
    }, 500);

    scheduleAttach();
  }

  fetchAndApplySettings();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOverlay, { once: true });
  } else {
    initOverlay();
  }

  browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) {
      return;
    }

    if (message.type === "PIXIV_COLLECT_IMAGES") {
      (async () => {
        try {
          const result = await collectPixivMedia();
          sendResponse(result);
        } catch (err) {
          sendResponse({ success: false, error: err?.message || "Pixiv verileri alınamadı." });
        }
      })();
      return true;
    }

    if (message.type === "PIXIV_SETTINGS_PUSH") {
      applySettingsPatch(message.payload || {});
      if (
        extensionSettings.language &&
        extensionSettings.language !== DEFAULT_LANGUAGE &&
        !localeBundles.has(extensionSettings.language)
      ) {
        ensureLocaleBundle(extensionSettings.language).catch(() => {});
      }
      sendResponse?.({ success: true });
      return;
    }

    if (message.type === "PIXIV_PROMPT_SELECTION") {
      const payload = message.payload || {};
      const total = Math.max(1, Math.floor(Number(payload.total) || 1));
      const defaults = payload.defaults || {};
      const meta = { images: Array.from({ length: total }) };

      (async () => {
        try {
          const selection = await promptSelection(meta, defaults);
          if (!selection) {
            sendResponse({ success: false, cancelled: true });
            return;
          }

          if (selection.mode === "range") {
            applySettingsPatch({ customRangeStart: selection.start, customRangeEnd: selection.end });
          }

          sendResponse({ success: true, selection });
        } catch (err) {
          console.error("Prompt selection via background failed", err);
          sendResponse({ success: false, error: err?.message || "prompt-failed" });
        }
      })();

      return true;
    }
  });
})();
