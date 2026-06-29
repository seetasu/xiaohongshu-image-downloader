const DB_NAME = "xhs-image-organizer";
const STORE_NAME = "settings";
const DIRECTORY_KEY = "selectedDirectory";

const statusEl = document.querySelector("#status");
const previewEl = document.querySelector("#preview");
const downloadButton = document.querySelector("#download");
const refreshButton = document.querySelector("#refresh");
const savePathInput = document.querySelector("#savePath");
const choosePathButton = document.querySelector("#choosePath");
const storageNameInput = document.querySelector("#storageName");
const saveModeEl = document.querySelector("#saveMode");
const modePostButton = document.querySelector("#modePost");
const modeImagesButton = document.querySelector("#modeImages");
const selectionCountEl = document.querySelector("#selectionCount");
const toggleSelectionButton = document.querySelector("#toggleSelection");

let collected = null;
let currentTab = null;
let selectedDirectoryHandle = null;
let selectedImageUrls = new Set();
let selectedVideoUrls = new Set();
let saveMode = "post";

document.addEventListener("DOMContentLoaded", init);
document.addEventListener("keydown", handleEnterToSave);
refreshButton.addEventListener("click", refresh);
choosePathButton.addEventListener("click", chooseSavePath);
downloadButton.addEventListener("click", downloadAll);
toggleSelectionButton.addEventListener("click", toggleAllImages);
modePostButton.addEventListener("click", () => setSaveMode("post", true));
modeImagesButton.addEventListener("click", () => setSaveMode("images", true));

async function init() {
  selectedDirectoryHandle = await getStoredDirectoryHandle();
  saveMode = await getStoredSaveMode();
  setSaveMode(saveMode, false);
  await updateSavePathLabel();
  await refresh();
}

async function refresh() {
  setLoading("正在识别当前帖子...");
  previewEl.textContent = "";
  selectedImageUrls.clear();
  selectedVideoUrls.clear();
  updateSelectionUi();
  downloadButton.disabled = true;

  try {
    const tab = await getTargetTab();
    currentTab = tab || null;
    if (!tab?.id || !/xiaohongshu\.com/.test(tab.url || "")) {
      setStatus("请先打开一个小红书帖子页面。");
      return;
    }

    await ensureContentScript(tab.id);
    collected = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_NOTE_IMAGES" });
    const fallbackName = sanitizePathPart(collected?.title || tab.title || "note");
    storageNameInput.value = storageNameInput.value || fallbackName;

    renderResult(collected);
  } catch (error) {
    setStatus("识别失败。刷新小红书页面后再试一次。");
    console.error(error);
  }
}

async function getTargetTab() {
  const e2eTabId = new URLSearchParams(location.search).get("e2eTabId");
  if (e2eTabId && chrome.tabs.get) {
    return chrome.tabs.get(Number(e2eTabId));
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function chooseSavePath() {
  if (!window.showDirectoryPicker) {
    setStatus("当前浏览器不支持选择文件夹，请使用 Chrome 或 Edge。");
    return;
  }

  try {
    selectedDirectoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await storeDirectoryHandle(selectedDirectoryHandle);
    await updateSavePathLabel();
    setStatus("已选择保存路径。");
  } catch (error) {
    if (error?.name !== "AbortError") {
      setStatus("选择保存路径失败。");
      console.error(error);
    }
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

function renderResult(result) {
  const images = result?.images || [];
  const videos = result?.videos || [];
  selectedImageUrls = new Set(images.map((image) => image.url));
  selectedVideoUrls = new Set(videos.map((video) => video.url));
  updateSelectionUi();

  if (images.length === 0 && videos.length === 0) {
    setStatus("没有识别到帖子图片或视频。请确认内容已加载完成。");
    return;
  }

  setStatus(`已识别 ${mediaCountText(images.length, videos.length)}。`);
  previewEl.textContent = "";

  images.forEach((image, index) => {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "thumb selected";
    thumb.dataset.type = "image";
    thumb.dataset.index = String(index);
    thumb.title = "点击取消选择";
    thumb.setAttribute("aria-pressed", "true");

    const img = document.createElement("img");
    img.src = image.url;
    img.alt = "";

    const checkmark = document.createElement("span");
    checkmark.className = "checkmark";
    checkmark.setAttribute("aria-hidden", "true");

    thumb.append(img, checkmark);
    thumb.addEventListener("click", () => toggleImage(image.url, thumb));
    previewEl.appendChild(thumb);
  });

  videos.forEach((video, index) => {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "thumb video-thumb selected";
    thumb.dataset.type = "video";
    thumb.dataset.index = String(index);
    thumb.title = "点击取消选择";
    thumb.setAttribute("aria-pressed", "true");

    const badge = document.createElement("span");
    badge.className = "video-badge";
    badge.textContent = "视频";

    const checkmark = document.createElement("span");
    checkmark.className = "checkmark";
    checkmark.setAttribute("aria-hidden", "true");

    thumb.append(badge, checkmark);
    thumb.addEventListener("click", () => toggleVideo(video.url, thumb));
    previewEl.appendChild(thumb);
  });
}

async function downloadAll() {
  const images = getSelectedImages();
  const videos = getSelectedVideos();
  if (images.length === 0 && videos.length === 0) return;

  downloadButton.disabled = true;

  try {
    const screenshotDataUrl = saveMode === "post" ? await capturePostScreenshot() : "";

    if (selectedDirectoryHandle && await hasDirectoryPermission(selectedDirectoryHandle, true)) {
      const started = await savePackageToChosenDirectory(images, videos, screenshotDataUrl);
      setStatus(`${saveMode === "post" ? "素材包" : "图片"}已保存，共 ${started} 个文件。`);
      closePopupSoon();
    } else {
      const started = await savePackageToBrowserDownloads(images, videos, screenshotDataUrl);
      if (started > 0) closePopupSoon();
    }
  } catch (error) {
    setStatus("下载失败。");
    console.error(error);
  } finally {
    downloadButton.disabled = false;
  }
}

function handleEnterToSave(event) {
  if (event.key !== "Enter" || downloadButton.disabled) return;
  const tagName = document.activeElement?.tagName?.toLowerCase();
  if (tagName === "button") return;

  event.preventDefault();
  downloadAll();
}

async function setSaveMode(mode, shouldStore) {
  saveMode = mode === "images" ? "images" : "post";
  if (saveMode === "images") {
    selectedVideoUrls.clear();
  }
  saveModeEl.classList.toggle("images", saveMode === "images");
  modePostButton.classList.toggle("active", saveMode === "post");
  modeImagesButton.classList.toggle("active", saveMode === "images");
  modePostButton.setAttribute("aria-checked", saveMode === "post" ? "true" : "false");
  modeImagesButton.setAttribute("aria-checked", saveMode === "images" ? "true" : "false");
  downloadButton.textContent = saveMode === "post" ? "保存素材包" : "保存图片";
  renderSelectionState();
  updateSelectionUi();

  if (shouldStore) {
    await storeSaveMode(saveMode);
  }
}

function toggleImage(url, thumb) {
  if (selectedImageUrls.has(url)) {
    selectedImageUrls.delete(url);
    thumb.classList.remove("selected");
    thumb.title = "点击选择";
    thumb.setAttribute("aria-pressed", "false");
  } else {
    selectedImageUrls.add(url);
    thumb.classList.add("selected");
    thumb.title = "点击取消选择";
    thumb.setAttribute("aria-pressed", "true");
  }

  updateSelectionUi();
}

function toggleVideo(url, thumb) {
  if (saveMode === "images") {
    selectedVideoUrls.delete(url);
    thumb.classList.remove("selected");
    thumb.title = "只保存图片模式不会保存视频";
    thumb.setAttribute("aria-pressed", "false");
    setStatus("只保存图片模式不会保存视频。");
    updateSelectionUi();
    return;
  }

  if (selectedVideoUrls.has(url)) {
    selectedVideoUrls.delete(url);
    thumb.classList.remove("selected");
    thumb.title = "点击选择";
    thumb.setAttribute("aria-pressed", "false");
  } else {
    selectedVideoUrls.add(url);
    thumb.classList.add("selected");
    thumb.title = "点击取消选择";
    thumb.setAttribute("aria-pressed", "true");
  }

  updateSelectionUi();
}

function toggleAllImages() {
  const images = collected?.images || [];
  const videos = saveMode === "post" ? collected?.videos || [] : [];
  const total = images.length + videos.length;
  const selected = selectedImageUrls.size + selectedVideoUrls.size;
  if (total === 0) return;

  if (selected === total) {
    selectedImageUrls.clear();
    selectedVideoUrls.clear();
  } else {
    selectedImageUrls = new Set(images.map((image) => image.url));
    selectedVideoUrls = new Set(videos.map((video) => video.url));
  }

  renderSelectionState();
  updateSelectionUi();
}

function renderSelectionState() {
  previewEl.querySelectorAll(".thumb").forEach((thumb) => {
    const index = Number(thumb.dataset.index || 0);
    const type = thumb.dataset.type || "image";
    const media = type === "video" ? collected?.videos?.[index] : collected?.images?.[index];
    const selected = media && (type === "video" ? saveMode === "post" && selectedVideoUrls.has(media.url) : selectedImageUrls.has(media.url));
    thumb.classList.toggle("selected", Boolean(selected));
    thumb.title = type === "video" && saveMode === "images" ? "只保存图片模式不会保存视频" : selected ? "点击取消选择" : "点击选择";
    thumb.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function updateSelectionUi() {
  const totalImages = collected?.images?.length || 0;
  const totalVideos = saveMode === "post" ? collected?.videos?.length || 0 : 0;
  const total = totalImages + totalVideos;
  const selectedVideos = saveMode === "post" ? selectedVideoUrls.size : 0;
  const selected = selectedImageUrls.size + selectedVideos;
  selectionCountEl.textContent = `已选择 ${mediaCountText(selectedImageUrls.size, selectedVideos)}`;
  toggleSelectionButton.disabled = total === 0;
  toggleSelectionButton.textContent = selected === total && total > 0 ? "取消全选" : "全选";
  downloadButton.disabled = selected === 0;
}

function getSelectedImages() {
  return (collected?.images || []).filter((image) => selectedImageUrls.has(image.url));
}

function getSelectedVideos() {
  if (saveMode === "images") return [];
  return (collected?.videos || []).filter((video) => selectedVideoUrls.has(video.url));
}

function mediaCountText(imageCount, videoCount) {
  const parts = [];
  if (imageCount > 0) parts.push(`${imageCount} 张图片`);
  if (videoCount > 0) parts.push(`${videoCount} 个视频`);
  return parts.join("、") || "0 个素材";
}

async function savePackageToBrowserDownloads(images, videos, screenshotDataUrl) {
  setStatus(`正在保存${saveMode === "post" ? "素材包" : "媒体"}，包含 ${mediaCountText(images.length, videos.length)}...`);

  const response = await chrome.runtime.sendMessage({
    type: "DOWNLOAD_PACKAGE",
    images,
    videos,
    saveMode,
    storageName: storageNameInput.value || "note",
    title: collected?.title || "",
    content: collected?.content || "",
    author: collected?.author || "",
    url: collected?.url || "",
    screenshotDataUrl
  });

  if (response?.ok) {
    setStatus(`已开始保存 ${response.started} 个文件，请查看浏览器下载列表。`);
    return response.started || 0;
  } else {
    setStatus(response?.error || "下载启动失败。");
    return 0;
  }
}

function closePopupSoon() {
  window.setTimeout(() => window.close(), 250);
}

async function savePackageToChosenDirectory(images, videos, screenshotDataUrl) {
  const folderName = sanitizePathPart(storageNameInput.value || "note");
  const uniqueFolderName = await uniqueDirectoryName(selectedDirectoryHandle, folderName);
  const targetDirectory = await selectedDirectoryHandle.getDirectoryHandle(uniqueFolderName, { create: true });
  const imagesDirectory = await targetDirectory.getDirectoryHandle("images", { create: true });
  const videosDirectory = videos.length > 0 ? await targetDirectory.getDirectoryHandle("videos", { create: true }) : null;
  let started = 0;

  setStatus(`正在保存${saveMode === "post" ? "素材包" : "媒体"}，包含 ${mediaCountText(images.length, videos.length)}...`);

  if (saveMode === "post") {
    started += await writeTextFile(targetDirectory, "正文.txt", collected?.content || "");
    started += await writeHtmlFile(targetDirectory, "原帖链接.html", buildLinkHtml(collected?.url || "", collected?.title || ""));

    if (screenshotDataUrl) {
      started += await writeBlobFile(targetDirectory, "截图.png", dataUrlToBlob(screenshotDataUrl));
    }
  }

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (!image?.url || !/^https?:\/\//i.test(image.url)) continue;

    const ext = extensionFromUrl(image.url, image.type);
    const number = String(index + 1).padStart(2, "0");
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    started += await writeBlobFile(imagesDirectory, `${number}${ext}`, await response.blob());
    setStatus(`正在保存图片 ${index + 1}/${images.length}...`);
  }

  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    if (!video?.url || !/^https?:\/\//i.test(video.url)) continue;

    const ext = videoExtensionFromUrl(video.url, video.type);
    const number = String(index + 1).padStart(2, "0");
    const response = await fetch(video.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    started += await writeBlobFile(videosDirectory, `${number}${ext}`, await response.blob());
    setStatus(`正在保存视频 ${index + 1}/${videos.length}...`);
  }

  return started;
}

async function uniqueDirectoryName(parentDirectory, baseName) {
  if (!await directoryExists(parentDirectory, baseName)) return baseName;

  for (let index = 2; index < 1000; index += 1) {
    const nextName = `${baseName} ${index}`;
    if (!await directoryExists(parentDirectory, nextName)) return nextName;
  }

  return `${baseName} ${Date.now()}`;
}

async function directoryExists(parentDirectory, name) {
  try {
    await parentDirectory.getDirectoryHandle(name, { create: false });
    return true;
  } catch {
    return false;
  }
}

async function capturePostScreenshot() {
  if (!currentTab?.windowId) return "";

  try {
    return await chrome.tabs.captureVisibleTab(currentTab.windowId, { format: "png" });
  } catch (error) {
    console.warn("Screenshot failed:", error);
    return "";
  }
}

async function writeTextFile(directory, filename, text) {
  return writeBlobFile(directory, filename, new Blob([String(text || "")], { type: "text/plain;charset=utf-8" }));
}

async function writeHtmlFile(directory, filename, html) {
  return writeBlobFile(directory, filename, new Blob([String(html || "")], { type: "text/html;charset=utf-8" }));
}

async function writeBlobFile(directory, filename, blob) {
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();

  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }

  return 1;
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/data:(.*?);/)?.[1] || "application/octet-stream";
  const binary = atob(data || "");
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mime });
}

function buildLinkHtml(url, title) {
  const safeUrl = escapeHtml(url);
  const safeTitle = escapeHtml(title || "打开原帖");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <meta http-equiv="refresh" content="0; url=${safeUrl}">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; line-height: 1.6; color: #252525; }
      a { color: #d2393a; font-weight: 700; }
    </style>
  </head>
  <body>
    <p>正在打开原帖...</p>
    <p><a href="${safeUrl}" rel="noreferrer">如果没有自动跳转，点击这里打开原帖</a></p>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function updateSavePathLabel() {
  if (!selectedDirectoryHandle) {
    savePathInput.value = defaultDownloadPathLabel();
    return;
  }

  savePathInput.value = selectedDirectoryHandle.name ? `.../${selectedDirectoryHandle.name}` : ".../已选择文件夹";
}

function defaultDownloadPathLabel() {
  return "下载";
}

async function hasDirectoryPermission(handle, requestWrite) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  if (!requestWrite) return false;
  return (await handle.requestPermission(options)) === "granted";
}

function setLoading(text) {
  statusEl.textContent = text;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function sanitizePathPart(value) {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 80) || "note";
}

function extensionFromUrl(url, type) {
  if (/png/i.test(type || "") || /\.png(?:[?#]|$)/i.test(url)) return ".png";
  if (/webp/i.test(type || "") || /\.webp(?:[?#]|$)/i.test(url)) return ".webp";
  if (/gif/i.test(type || "") || /\.gif(?:[?#]|$)/i.test(url)) return ".gif";
  if (/jpeg|jpg/i.test(type || "") || /\.jpe?g(?:[?#]|$)/i.test(url)) return ".jpg";
  return ".jpg";
}

function videoExtensionFromUrl(url, type) {
  return ".mp4";
}

async function getStoredDirectoryHandle() {
  return readSetting(DIRECTORY_KEY);
}

async function storeDirectoryHandle(handle) {
  return writeSetting(DIRECTORY_KEY, handle);
}

async function clearStoredDirectoryHandle() {
  return deleteSetting(DIRECTORY_KEY);
}

async function getStoredSaveMode() {
  const mode = await readSetting("saveMode");
  return mode === "images" ? "images" : "post";
}

async function storeSaveMode(mode) {
  return writeSetting("saveMode", mode === "images" ? "images" : "post");
}

function openSettingsDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSetting(key) {
  const db = await openSettingsDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function writeSetting(key, value) {
  const db = await openSettingsDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function deleteSetting(key) {
  const db = await openSettingsDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}
