chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "DOWNLOAD_PACKAGE") {
    return false;
  }

  downloadPackage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function downloadPackage(message) {
  const images = message.images || [];
  const saveMode = message.saveMode === "images" ? "images" : "post";
  const videos = saveMode === "images" ? [] : message.videos || [];
  if ((!Array.isArray(images) || images.length === 0) && (!Array.isArray(videos) || videos.length === 0)) {
    return { started: 0 };
  }

  const targetFolder = await buildUniqueTargetFolder(message.savePath || "", message.storageName || "");
  let started = 0;

  if (saveMode === "post") {
    started += await downloadTextFile(`${targetFolder}/正文.txt`, message.content || "");
    started += await downloadHtmlFile(`${targetFolder}/原帖链接.html`, buildLinkHtml(message.url || "", message.title || ""));

    if (message.screenshotDataUrl) {
      started += await downloadFile(`${targetFolder}/截图.png`, message.screenshotDataUrl);
      await sleep(120);
    }
  }

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (!image?.url || !/^https?:\/\//i.test(image.url)) continue;

    const ext = extensionFromUrl(image.url, image.type);
    const number = String(index + 1).padStart(2, "0");
    const filename = `${targetFolder}/images/${number}${ext}`;

    if (await downloadFile(filename, image.url)) {
      started += 1;
      await sleep(180);
    }
  }

  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    if (!video?.url || !/^https?:\/\//i.test(video.url)) continue;

    const ext = videoExtensionFromUrl(video.url, video.type);
    const number = String(index + 1).padStart(2, "0");
    const filename = `${targetFolder}/videos/${number}${ext}`;

    if (await downloadFile(filename, video.url)) {
      started += 1;
      await sleep(180);
    }
  }

  return { started };
}

async function downloadTextFile(filename, text) {
  return downloadFile(filename, textDataUrl(text));
}

async function downloadHtmlFile(filename, html) {
  return downloadFile(filename, htmlDataUrl(html));
}

async function downloadFile(filename, url) {
  try {
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    return 1;
  } catch (error) {
    console.warn("Download failed:", filename, error);
    return 0;
  }
}

function textDataUrl(text) {
  const encoded = encodeURIComponent(String(text || ""));
  return `data:text/plain;charset=utf-8,${encoded}`;
}

function htmlDataUrl(html) {
  const encoded = encodeURIComponent(String(html || ""));
  return `data:text/html;charset=utf-8,${encoded}`;
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

async function buildUniqueTargetFolder(savePath, storageName) {
  const folder = sanitizeDownloadPath(savePath);
  const name = sanitizeDownloadPath(storageName) || "note";
  const key = [folder, name].filter(Boolean).join("/");
  const nextNumber = await nextPackageNumber(key);
  const numberedName = nextNumber === 1 ? name : `${name} ${nextNumber}`;

  return [folder, numberedName].filter(Boolean).join("/");
}

async function nextPackageNumber(key) {
  const storageKey = "packageFolderCounters";
  const data = await chrome.storage.local.get(storageKey);
  const counters = data[storageKey] || {};
  const nextNumber = Number(counters[key] || 0) + 1;
  counters[key] = nextNumber;
  await chrome.storage.local.set({ [storageKey]: counters });
  return nextNumber;
}

function sanitizeDownloadPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim().replace(/[:*?"<>|]+/g, "-"))
    .filter(Boolean)
    .join("/")
    .replace(/\s+/g, " ")
    .slice(0, 120);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
