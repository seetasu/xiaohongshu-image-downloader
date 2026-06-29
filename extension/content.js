const MIN_IMAGE_SIDE = 240;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "COLLECT_NOTE_IMAGES") {
    if (message?.type === "PING") sendResponse({ ok: true });
    return false;
  }

  sendResponse(collectNoteImages());
  return false;
});

function collectNoteImages() {
  const root = findNoteRoot();
  const metadata = collectNoteMetadata(root);
  const domCandidates = collectImageCandidates(root);
  const activeImageKey = findActiveImageKey(domCandidates);
  const candidates = [
    ...domCandidates,
    ...collectEmbeddedImageCandidates()
  ];
  const images = rotateImagesToActive(
    uniqueImages(candidates)
    .filter(isLikelyPostImage)
      .sort((a, b) => a.index - b.index),
    activeImageKey
  ).map(({ url, width, height, type }) => ({ url, width, height, type }));
  const videos = uniqueVideos([
    ...collectVideoCandidates(root),
    ...collectEmbeddedVideoCandidates()
  ]).map(({ url, type }) => ({ url, type }));

  return {
    url: location.href,
    title: metadata.title,
    content: metadata.content,
    author: metadata.author,
    collectedAt: new Date().toISOString(),
    count: images.length,
    images,
    videos
  };
}

function collectNoteMetadata(root) {
  const title = firstText([
    "#detail-title",
    ".title",
    ".note-title",
    "[class*='title']"
  ], root) || metaContent("og:title") || cleanText(document.title).replace(/ - 小红书$/, "");

  const content = firstText([
    "#detail-desc",
    ".desc",
    ".note-text",
    ".content",
    "[class*='desc']",
    "[class*='content']"
  ], root) || metaContent("description") || "";

  const author = firstText([
    ".author .name",
    ".user-name",
    ".username",
    "[class*='author'] [class*='name']",
    "[class*='user'] [class*='name']"
  ], root);

  return {
    title: cleanText(title) || "小红书素材",
    content: cleanText(content),
    author: cleanText(author)
  };
}

function firstText(selectors, root) {
  for (const selector of selectors) {
    const element = (root || document).querySelector(selector);
    const text = cleanText(element?.innerText || element?.textContent || "");
    if (text && text.length > 1) return text;
  }

  return "";
}

function metaContent(name) {
  const element = document.querySelector(`meta[property='${name}'], meta[name='${name}']`);
  return cleanText(element?.content || "");
}

function findNoteRoot() {
  const selectors = [
    ".note-detail-mask",
    ".note-detail",
    "#noteContainer",
    ".note-container",
    ".media-container",
    ".swiper",
    "main",
    "body"
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element && element.querySelector("img")) return element;
  }

  return document.body;
}

function collectImageCandidates(root) {
  const candidates = [];
  const scopedRoot = root || document.body;

  scopedRoot.querySelectorAll("img").forEach((img, index) => {
    const urls = [
      img.currentSrc,
      img.src,
      bestFromSrcset(img.srcset),
      img.getAttribute("data-src"),
      img.getAttribute("data-original")
    ].filter(Boolean);

    for (const url of urls) {
      candidates.push(candidateFromElement(url, img, index));
    }
  });

  scopedRoot.querySelectorAll("[style*='background-image']").forEach((element, index) => {
    for (const url of urlsFromBackground(element.style.backgroundImage)) {
      candidates.push(candidateFromElement(url, element, index + 10000));
    }
  });

  return candidates;
}

function collectVideoCandidates(root) {
  const candidates = [];
  const scopedRoot = root || document.body;

  scopedRoot.querySelectorAll("video").forEach((video, index) => {
    const urls = [
      video.currentSrc,
      video.src,
      video.getAttribute("data-src")
    ].filter(Boolean);

    video.querySelectorAll("source").forEach((source) => {
      if (source.src) urls.push(source.src);
      if (source.getAttribute("data-src")) urls.push(source.getAttribute("data-src"));
    });

    urls.forEach((url) => {
      candidates.push({
        url: normalizeMediaUrl(url),
        type: videoTypeHint(url),
        index
      });
    });
  });

  return candidates;
}

function collectEmbeddedImageCandidates() {
  const candidates = [];
  const scripts = Array.from(document.scripts).slice(0, 80);
  const urlPattern = /https?:\\?\/\\?\/[^"'<>\s]+?(?:xhscdn\.com|xiaohongshu\.com)[^"'<>\s]+/gi;

  scripts.forEach((script, scriptIndex) => {
    const text = script.textContent || "";
    if (!/xhscdn\.com|imageList|note|xiaohongshu/i.test(text)) return;

    Array.from(text.matchAll(urlPattern)).forEach((match, matchIndex) => {
      const url = match[0].replaceAll("\\/", "/").replaceAll("\\u002F", "/");
      candidates.push({
        url: normalizeImageUrl(url),
        width: 1000,
        height: 1000,
        index: 20000 + scriptIndex * 100 + matchIndex,
        type: contentTypeHint(url),
        visible: true,
        score: 40
      });
    });
  });

  return candidates;
}

function collectEmbeddedVideoCandidates() {
  const candidates = [];
  const scripts = Array.from(document.scripts).slice(0, 100);
  const urlPattern = /https?:\\?\/\\?\/[^"'<>\s]+?\.mp4[^"'<>\s]*/gi;

  scripts.forEach((script, scriptIndex) => {
    const text = script.textContent || "";
    if (!/video|mp4|xiaohongshu|xhscdn/i.test(text)) return;

    Array.from(text.matchAll(urlPattern)).forEach((match, matchIndex) => {
      const url = match[0].replaceAll("\\/", "/").replaceAll("\\u002F", "/");
      candidates.push({
        url: normalizeMediaUrl(url),
        type: videoTypeHint(url),
        index: scriptIndex * 100 + matchIndex
      });
    });
  });

  return candidates;
}

function candidateFromElement(rawUrl, element, index) {
  const rect = element.getBoundingClientRect();
  const normalized = normalizeImageUrl(rawUrl);
  const width = element.naturalWidth || rect.width || 0;
  const height = element.naturalHeight || rect.height || 0;
  const className = String(element.className || "");
  const alt = element.getAttribute?.("alt") || "";
  const type = contentTypeHint(normalized);

  return {
    url: normalized,
    width,
    height,
    index,
    type,
    visible: rect.width > 10 && rect.height > 10,
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    },
    score: scoreImage({ element, width, height, className, alt })
  };
}

function normalizeImageUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    parsed.hash = "";

    if (/xhscdn\.com|xiaohongshu\.com/i.test(parsed.hostname)) {
      parsed.searchParams.delete("imageView2");
      parsed.searchParams.delete("format");
      parsed.searchParams.delete("quality");
    }

    return parsed.href;
  } catch {
    return "";
  }
}

function normalizeMediaUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    parsed.hash = "";
    return parsed.href.replaceAll("\\u002F", "/").replaceAll("\\/", "/");
  } catch {
    return "";
  }
}

function bestFromSrcset(srcset) {
  if (!srcset) return "";

  return srcset
    .split(",")
    .map((item) => item.trim().split(/\s+/))
    .filter(([url]) => url)
    .sort((a, b) => parseFloat(b[1] || "0") - parseFloat(a[1] || "0"))[0]?.[0] || "";
}

function urlsFromBackground(backgroundImage) {
  return Array.from(backgroundImage.matchAll(/url\(["']?(.+?)["']?\)/g)).map((match) => match[1]);
}

function uniqueImages(candidates) {
  const seen = new Map();

  for (const candidate of candidates) {
    if (!candidate.url || !/^https?:\/\//i.test(candidate.url)) continue;

    const key = candidate.url.replace(/\?.*$/, "");
    const existing = seen.get(key);
    if (!existing || candidate.index < existing.index || (candidate.index === existing.index && candidate.score > existing.score)) {
      seen.set(key, candidate);
    }
  }

  return Array.from(seen.values());
}

function uniqueVideos(candidates) {
  const seen = new Map();

  candidates
    .filter((candidate) => isLikelyPostVideo(candidate))
    .sort((a, b) => a.index - b.index)
    .forEach((candidate) => {
      const key = imageKey(candidate.url);
      if (!seen.has(key)) seen.set(key, candidate);
    });

  return Array.from(seen.values());
}

function findActiveImageKey(candidates) {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportCenterX = viewportWidth / 2;
  const viewportCenterY = viewportHeight / 2;

  const active = candidates
    .filter(isLikelyPostImage)
    .map((candidate) => ({
      candidate,
      score: activeImageScore(candidate, viewportCenterX, viewportCenterY)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.candidate;

  return active ? imageKey(active.url) : "";
}

function activeImageScore(candidate, viewportCenterX, viewportCenterY) {
  const rect = candidate.rect;
  if (!rect) return 0;

  const visibleWidth = Math.max(0, Math.min(rect.left + rect.width, window.innerWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.top + rect.height, window.innerHeight) - Math.max(rect.top, 0));
  const visibleArea = visibleWidth * visibleHeight;
  if (visibleArea < MIN_IMAGE_SIDE * MIN_IMAGE_SIDE) return 0;

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const distance = Math.hypot(centerX - viewportCenterX, centerY - viewportCenterY);
  const centerBonus = Math.max(0, 1000 - distance);
  const sizeBonus = Math.min(visibleArea / 1000, 3000);

  return centerBonus + sizeBonus + candidate.score;
}

function rotateImagesToActive(images, activeKey) {
  if (!activeKey || images.length < 2) return images;

  const activeIndex = images.findIndex((image) => imageKey(image.url) === activeKey);
  if (activeIndex <= 0) return images;

  return [
    ...images.slice(activeIndex),
    ...images.slice(0, activeIndex)
  ];
}

function imageKey(url) {
  return String(url || "").replace(/\?.*$/, "");
}

function isLikelyPostImage(image) {
  if (!image.visible) return false;
  if (Math.max(image.width, image.height) < MIN_IMAGE_SIDE) return false;
  if (/avatar|icon|emoji|sprite|logo|profile|comment/i.test(image.url)) return false;
  return /xhscdn\.com|xiaohongshu\.com/i.test(image.url);
}

function isLikelyPostVideo(video) {
  if (!video?.url || !/^https?:\/\//i.test(video.url)) return false;
  if (!/\.mp4(?:[?#]|$)/i.test(video.url)) return false;
  return /xhscdn\.com|xiaohongshu\.com/i.test(video.url);
}

function scoreImage({ element, width, height, className, alt }) {
  let score = Math.min(width * height, 2000000) / 10000;
  const text = `${className} ${alt}`.toLowerCase();
  const ancestry = ancestorText(element).toLowerCase();

  if (/swiper|slider|slide|media|note|image|photo|carousel/.test(text)) score += 120;
  if (/swiper|slider|slide|media|note|image|photo|carousel/.test(ancestry)) score += 80;
  if (/avatar|user|author|comment|emoji|icon|logo/.test(text + ancestry)) score -= 180;
  if (width >= 500 || height >= 500) score += 80;

  return score;
}

function ancestorText(element) {
  const parts = [];
  let current = element;

  for (let i = 0; current && i < 4; i += 1) {
    parts.push(current.id || "", current.className || "");
    current = current.parentElement;
  }

  return parts.join(" ");
}

function contentTypeHint(url) {
  if (/\.png(?:[?#]|$)/i.test(url)) return "image/png";
  if (/\.webp(?:[?#]|$)/i.test(url)) return "image/webp";
  if (/\.gif(?:[?#]|$)/i.test(url)) return "image/gif";
  return "image/jpeg";
}

function videoTypeHint(url) {
  return "video/mp4";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
