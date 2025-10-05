const browserApi = typeof browser !== "undefined" ? browser : chrome;
const IS_CHROME = typeof browser === "undefined";

const FALLBACK_MESSAGES = {
  optionsTitle: "Pixiv Bulk Downloader Settings",
  optionsHeading: "Pixiv Bulk Downloader",
  optionsSubheading: "Customize how downloads behave and discover more projects.",
  optionsGeneralTitle: "General preferences",
  optionsLanguageLabel: "Interface language",
  optionsLanguageEn: "English",
  optionsLanguageJa: "日本語",
  optionsLanguageZhCN: "简体中文",
  optionsLanguageHint: "Override the locale used for the overlay and toolbar.",
  optionsRangeLabel: "Default page range",
  optionsRangeAll: "Download all pages",
  optionsRangePrompt: "Ask every time",
  optionsRangeCustom: "Use custom range",
  optionsRangeHint: "When set to \"custom\", the overlay remembers your last range.",
  optionsAntiTheftLabel: "Add anti-theft suffix to filenames",
  optionsAntiTheftHint: "Appends _pixiv-only to each saved file.",
  optionsOverlayLabel: "Show on-canvas download button",
  optionsOverlayHint: "Disable if you prefer using the toolbar icon only.",
  optionsDownloadTitle: "Download behavior",
  optionsRootFolderLabel: "Root folder name",
  optionsRootFolderHint: "Defaults to \"Pixiv\". Windows-reserved names are sanitized automatically.",
  optionsRetryLabel: "Retry failed URLs",
  optionsRetryHint: "Makes up to 3 extra attempts using alternate URLs before giving up.",
  optionsCreatorTitle: "Creator spotlight",
  optionsCreatorBlurb: "Hi! I’m Plus(Anachter), the developer behind Pixiv Bulk Downloader. I made this extension because I was too lazy to right click and download 9 images :3 ",
  optionsCreatorSiteDescription: "Portfolio, blog posts, and upcoming tools.",
  optionsVisitSite: "Visit site",
  optionsProjectsTitle: "Other projects",
  optionsProjectsKuronekoAI: "Kuroneko AI — a cat-like assistant.",
  optionsSupportTitle: "Support & feedback",
  optionsSupportBugs: "Report a bug",
  optionsSupportFeature: "Request a feature",
  optionsSupportChangelog: "Read the changelog",
  optionsResetLabel: "Reset to defaults",
  optionsSaved: "Settings saved",
  optionsReset: "Settings restored",
  optionsError: "Something went wrong, please try again."
};

const SUPPORTED_LANGUAGES = new Set(["en", "ja", "zh_CN"]);

function normalizeLanguage(value) {
  if (value === "auto") {
    return "en";
  }
  if (SUPPORTED_LANGUAGES.has(value)) {
    return value;
  }
  return "en";
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

function getMessage(key) {
  try {
    if (browserApi?.i18n?.getMessage) {
      const localized = browserApi.i18n.getMessage(key);
      if (localized) {
        return localized;
      }
    }
  } catch (err) {
    console.warn("i18n lookup failed", key, err);
  }

  const fallback = FALLBACK_MESSAGES[key];
  if (typeof fallback === "string") {
    return fallback;
  }
  return key;
}

function ensureSafeRootFolder(value) {
  const normalized = (value || "")
    .toString()
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/g, "")
    .trim();

  if (!normalized) {
    return "Pixiv";
  }

  const lower = normalized.toLowerCase();
  if (WINDOWS_RESERVED_NAMES.has(lower)) {
    return `${normalized}_`;
  }

  return normalized.slice(0, 60);
}

const DEFAULT_SETTINGS = {
  language: "en",
  range: "all",
  customRangeStart: 1,
  customRangeEnd: 1,
  antiTheft: true,
  overlay: true,
  rootFolder: "Pixiv",
  retryFailed: true,
  projects: [
    {
      id: "kuronekoai",
      name: "Kuroneko AI",
      descriptionKey: "optionsProjectsKuronekoAI",
      url: "https://github.com/gokayplus/kuronekoai"
    }
  ]
};

function storageGet(area, defaults) {
  if (!area) {
    return Promise.resolve({ ...defaults });
  }

  if (IS_CHROME) {
    return new Promise((resolve) => {
      try {
        area.get(defaults, (result) => {
          const err = chrome.runtime.lastError;
          if (err) {
            console.warn("storage.get failed", err);
            resolve({ ...defaults });
            return;
          }
          resolve(result || { ...defaults });
        });
      } catch (err) {
        console.warn("storage.get threw", err);
        resolve({ ...defaults });
      }
    });
  }

  return area.get(defaults).catch((err) => {
    console.warn("storage.get failed", err);
    return { ...defaults };
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

async function loadSettings() {
  const syncArea = browserApi?.storage?.sync;
  const localArea = browserApi?.storage?.local;

  const syncValues = await storageGet(syncArea, DEFAULT_SETTINGS);
  if (syncArea && syncValues && Object.keys(syncValues).some((key) => key in DEFAULT_SETTINGS && key !== "projects")) {
    const merged = { ...DEFAULT_SETTINGS, ...syncValues };
    const normalizedLanguage = normalizeLanguage(merged.language);
    if (normalizedLanguage !== merged.language) {
      merged.language = normalizedLanguage;
      await persistSettings({ language: normalizedLanguage });
    }
    return merged;
  }

  const localValues = await storageGet(localArea, DEFAULT_SETTINGS);
  const mergedLocal = { ...DEFAULT_SETTINGS, ...localValues };
  const normalizedLocalLanguage = normalizeLanguage(mergedLocal.language);
  if (normalizedLocalLanguage !== mergedLocal.language) {
    mergedLocal.language = normalizedLocalLanguage;
    await persistSettings({ language: normalizedLocalLanguage });
  }
  return mergedLocal;
}

function persistSettings(settings) {
  const syncArea = browserApi?.storage?.sync;
  if (syncArea) {
    return storageSet(syncArea, settings);
  }
  return storageSet(browserApi?.storage?.local, settings);
}

function localizeDocument() {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.dataset.i18n;
    const message = getMessage(key);
    if (!message) return;
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.placeholder = message;
    } else if (node.dataset.i18n === "optionsCreatorBlurb") {
      node.innerHTML = message;
    } else if (node instanceof HTMLAnchorElement) {
      node.textContent = message;
    } else if (node instanceof HTMLOptionElement) {
      node.textContent = message;
    } else if (node instanceof HTMLTitleElement) {
      node.textContent = message;
    } else {
      node.textContent = message;
    }
  });
}

function renderProjects(projects) {
  const list = document.getElementById("promo-project-list");
  list.innerHTML = "";
  projects.forEach((project) => {
    const li = document.createElement("li");
    li.className = "promo-link";

    const name = document.createElement("strong");
    name.textContent = project.name;

    const description = document.createElement("span");
    description.textContent = getMessage(project.descriptionKey) || project.name;

    const anchor = document.createElement("a");
    anchor.href = project.url;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.dataset.i18n = "optionsVisitSite";
    const visitLabel = getMessage("optionsVisitSite") || FALLBACK_MESSAGES.optionsVisitSite;
    anchor.textContent = visitLabel;
    anchor.className = "promo-link__cta";

    li.append(name, description, anchor);
    list.append(li);
  });

  localizeDocument();
}

function hydrateForm(settings) {
  document.getElementById("language-select").value = settings.language;
  document.getElementById("range-select").value = settings.range;
  document.getElementById("anti-theft-checkbox").checked = Boolean(settings.antiTheft);
  document.getElementById("overlay-checkbox").checked = Boolean(settings.overlay);
  document.getElementById("root-folder-input").value = settings.rootFolder;
  document.getElementById("retry-failed-checkbox").checked = Boolean(settings.retryFailed);
  renderProjects(settings.projects || []);
}

function showStatus(messageKey, type = "info") {
  const el = document.getElementById("status-message");
  el.textContent = getMessage(messageKey) || messageKey;
  el.dataset.statusType = type;
  if (type === "saved") {
    el.classList.add("status-message--visible");
    setTimeout(() => {
      el.classList.remove("status-message--visible");
      el.textContent = "";
    }, 3000);
  }
}

function collectSettingsFromForm() {
  const language = normalizeLanguage(document.getElementById("language-select").value);
  const range = document.getElementById("range-select").value;
  const antiTheft = document.getElementById("anti-theft-checkbox").checked;
  const overlay = document.getElementById("overlay-checkbox").checked;
  const rootFolder = ensureSafeRootFolder(document.getElementById("root-folder-input").value || DEFAULT_SETTINGS.rootFolder);
  const retryFailed = document.getElementById("retry-failed-checkbox").checked;

  return { language, range, antiTheft, overlay, rootFolder, retryFailed };
}

async function saveSettings(evt) {
  evt?.preventDefault();
  const newSettings = collectSettingsFromForm();
  await persistSettings(newSettings);
  sendMessageSafe({ type: "PIXIV_SETTINGS_UPDATED", payload: newSettings });
  showStatus("optionsSaved", "saved");
}

async function resetSettings() {
  hydrateForm(DEFAULT_SETTINGS);
  await persistSettings(DEFAULT_SETTINGS);
  sendMessageSafe({ type: "PIXIV_SETTINGS_UPDATED", payload: DEFAULT_SETTINGS });
  showStatus("optionsReset", "saved");
}

async function init() {
  localizeDocument();
  const settings = await loadSettings();
  hydrateForm(settings);

  document.getElementById("settings-form").addEventListener("change", saveSettings);
  document.getElementById("download-form").addEventListener("change", saveSettings);
  document.getElementById("reset-button").addEventListener("click", resetSettings);
}

function sendMessageSafe(message) {
  try {
    const result = browserApi.runtime?.sendMessage?.(message);
    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }
  } catch (err) {
    console.warn("runtime.sendMessage failed", err);
  }
}

init().catch((err) => {
  console.error("Failed to initialize options page", err);
  showStatus("optionsError", "error");
});
