/**
 * Printboard - Background Service Worker
 * 
 * Orchestrates the bulk keyword download workflow:
 * 1. Receives keyword list from popup
 * 2. For each keyword, opens Pinterest search tab
 * 3. Injects content script to scrape images
 * 4. Downloads images and bundles them into ZIP
 * 5. Saves ZIP via chrome.downloads
 * 6. Reports progress back to popup
 */
importScripts('/lib/jszip.min.js');

// ── State ──
let popupPort = null;
let isRunning = false;
let shouldStop = false;
let currentTabId = null;
let keepAliveInterval = null;

let batchState = {
  keywords: [],
  currentIndex: 0,
  currentKeyword: '',
  statusText: '',
  logType: '',
  downloadProgress: { downloaded: 0, total: 0 },
  scrapeProgress: { count: 0 },
  logs: []
};

// ── Communication ──

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'printboard-popup') return;

  popupPort = port;
  
  if (isRunning) {
    port.postMessage({
      type: 'sync-state',
      state: batchState,
      isRunning: true
    });
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === 'start') {
      startBatch(msg.keywords, msg.scrollDelay);
    } else if (msg.type === 'stop') {
      stopBatch();
    }
  });

  port.onDisconnect.addListener(() => {
    popupPort = null;
    // Don't stop the batch — let it continue even if popup closes
  });
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'keep-alive') {
    return false;
  }
  if (message.type === 'scrape-progress' && popupPort) {
    sendToPopup({
      type: 'scrape-progress',
      count: message.count,
      progress: message.progress,
    });
  }
  // We do not need to send an async response for progress updates
  return false;
});

// Keep-alive for the background script
function startBackgroundKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}

function stopBackgroundKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function sendToPopup(msg) {
  // Update internal state for reconnects
  if (msg.type === 'keyword-start') {
    batchState.currentKeyword = msg.keyword;
    batchState.currentIndex = msg.index;
    batchState.downloadProgress = { downloaded: 0, total: 0 };
    batchState.scrapeProgress = { count: 0 };
    batchState.logs.push({ text: `Processing: "${msg.keyword}" (${msg.index + 1}/${msg.total})`, type: 'info' });
  } else if (msg.type === 'keyword-done') {
    batchState.currentKeyword = msg.keyword;
    batchState.currentIndex = msg.index;
  } else if (msg.type === 'status') {
    batchState.statusText = msg.text;
    batchState.logType = msg.logType || '';
    if (msg.logType) {
      batchState.logs.push({ text: msg.text, type: msg.logType });
    }
  } else if (msg.type === 'scrape-progress') {
    batchState.scrapeProgress.count = msg.count;
  } else if (msg.type === 'download-progress') {
    batchState.downloadProgress.downloaded = msg.downloaded;
    batchState.downloadProgress.total = msg.total;
  } else if (msg.type === 'error') {
    batchState.logs.push({ text: msg.text, type: 'error' });
  }

  // Keep log size manageable
  if (batchState.logs.length > 50) {
    batchState.logs.shift();
  }

  try {
    if (popupPort) {
      popupPort.postMessage(msg);
    }
  } catch (e) {
    popupPort = null;
  }
}

// ── Batch Processing ──

async function startBatch(keywords, scrollDelay) {
  if (isRunning) {
    sendToPopup({ type: 'error', text: 'A batch is already running!' });
    return;
  }

  isRunning = true;
  shouldStop = false;
  batchState.keywords = keywords;

  startBackgroundKeepAlive();
  // Prevent display from sleeping while scraping
  chrome.power.requestKeepAwake('display');

  const scrollDelayMs = {
    fast: 800,
    normal: 1500,
    slow: 2500,
  }[scrollDelay] || 1500;

  let successCount = 0;
  const total = keywords.length;

  for (let i = 0; i < keywords.length; i++) {
    if (shouldStop) {
      sendToPopup({ type: 'stopped' });
      break;
    }

    const keyword = keywords[i];

    sendToPopup({
      type: 'keyword-start',
      keyword,
      index: i,
      total,
    });

    try {
      const imageCount = await processKeyword(keyword, scrollDelayMs, i, total);
      successCount++;
      sendToPopup({
        type: 'keyword-done',
        keyword,
        index: i,
        total,
        imageCount,
      });
    } catch (err) {
      console.error(`Error processing "${keyword}":`, err);
      sendToPopup({
        type: 'keyword-error',
        keyword,
        index: i,
        total,
        error: err.message || String(err),
      });
    } finally {
      if (currentTabId) {
        try { await chrome.tabs.remove(currentTabId); } catch (e) {}
        currentTabId = null;
      }
    }

    // Small delay between keywords to be nice to Pinterest
    if (i < keywords.length - 1 && !shouldStop) {
      sendToPopup({ type: 'status', text: 'Waiting before next keyword...' });
      await delay(2000);
    }
  }

  if (!shouldStop) {
    sendToPopup({
      type: 'all-done',
      total,
      successCount,
    });
  }

  isRunning = false;
  shouldStop = false;
  currentTabId = null;

  stopBackgroundKeepAlive();
  // Release display keep-awake
  chrome.power.releaseKeepAwake();
}

function stopBatch() {
  shouldStop = true;
  stopBackgroundKeepAlive();

  // Release display keep-awake
  chrome.power.releaseKeepAwake();

  // Try to stop content script
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { type: 'stop-scraping' }).catch(() => {});
    // Close the tab
    chrome.tabs.remove(currentTabId).catch(() => {});
    currentTabId = null;
  }
}

// ── Process Single Keyword ──

async function processKeyword(keyword, scrollDelayMs, index, total) {
  // 1. Build Pinterest search URL
  const searchQuery = encodeURIComponent(keyword);
  
  sendToPopup({ type: 'status', text: `Opening Pinterest for "${keyword}"...`, logType: '' });

  // 2. Open new tab with Pinterest search
  const tab = await chrome.tabs.create({ 
    url: `https://www.pinterest.com/search/pins/?q=${searchQuery}`, 
    active: true 
  });
  currentTabId = tab.id;

  // 3. Wait for page to fully load
  await waitForTabLoad(tab.id, 30000);
  
  // Give Pinterest extra time to render dynamic content
  await delay(3000);

  if (shouldStop) throw new Error('Stopped by user');

  // 4. Inject and run content script to scrape images
  sendToPopup({ type: 'status', text: `Scrolling and collecting images...` });

  let imageUrls = [];

  try {
    // Inject the content script if not already present
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/script.js'],
    });

    // Small delay for script to initialize
    await delay(500);

    // Send scrape command — no image limit, scrape everything
    imageUrls = await sendMessageToTab(tab.id, {
      type: 'start-scraping',
      maxImages: 0, // 0 = unlimited
      scrollDelay: scrollDelayMs,
    }, 7200000); // 2 hour timeout for thorough scraping

  } catch (err) {
    throw new Error(`Scraping failed: ${err.message}`);
  }

  if (shouldStop) {
    throw new Error('Stopped by user');
  }

  if (!imageUrls || imageUrls.length === 0) {
    throw new Error('No images found');
  }

  sendToPopup({
    type: 'status',
    text: `Found ${imageUrls.length} images. Downloading...`,
    logType: 'info',
  });

  // 6. Download images and create ZIP
  const zip = new JSZip();
  const folder = zip.folder(sanitizeFilename(keyword));
  let downloaded = 0;
  let failed = 0;

  // Download in parallel batches of 5
  const batchSize = 5;
  for (let i = 0; i < imageUrls.length; i += batchSize) {
    if (shouldStop) throw new Error('Stopped by user');

    const batch = imageUrls.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((url, batchIdx) =>
        fetchImageAsBlob(url, i + batchIdx)
      )
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const imgIndex = i + j;
      if (result.status === 'fulfilled' && result.value) {
        const ext = getExtension(imageUrls[imgIndex]);
        const filename = `${String(imgIndex + 1).padStart(4, '0')}.${ext}`;
        folder.file(filename, result.value);
        downloaded++;
      } else {
        failed++;
      }
    }

    sendToPopup({
      type: 'download-progress',
      downloaded: downloaded + failed,
      total: imageUrls.length,
    });
  }

  if (downloaded === 0) {
    throw new Error('Could not download any images');
  }

  // 7. Generate ZIP and save
  sendToPopup({ type: 'status', text: `Creating ZIP file...` });

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 3 },
  });

  // Convert blob to data URL for chrome.downloads
  const dataUrl = await blobToDataUrl(zipBlob);
  const zipFilename = `Printboard/${sanitizeFilename(keyword)}.zip`;

  await chrome.downloads.download({
    url: dataUrl,
    filename: zipFilename,
    saveAs: false,
  });

  sendToPopup({
    type: 'status',
    text: `Saved: ${zipFilename} (${downloaded} images, ${failed} failed)`,
    logType: 'success',
  });

  return downloaded;
}

// ── Utilities ──

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      // Don't reject — page might still be usable
      resolve();
    }, timeout);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already loaded
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(reject);
  });
}

function sendMessageToTab(tabId, message, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Content script response timed out'));
    }, timeout);

    chrome.tabs.sendMessage(tabId, message)
      .then((response) => {
        clearTimeout(timer);
        if (response && response.error) {
          reject(new Error(response.error));
        } else if (response && response.images) {
          resolve(response.images);
        } else {
          resolve([]);
        }
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ── File Utilities ──

function getExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
      return ext;
    }
  } catch (e) {}
  return 'jpg';
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100)
    .toLowerCase();
}

async function fetchImageAsBlob(url, index) {
  try {
    let response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
    });

    // Fallback: If Pinterest 403s the 'originals/' path (common for older pins), fallback to '736x/'
    if (!response.ok && url.includes('/originals/')) {
      const fallbackUrl = url.replace('/originals/', '/736x/');
      response = await fetch(fallbackUrl, { mode: 'cors', credentials: 'omit' });
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.blob();
  } catch (err) {
    console.warn(`Failed to fetch image #${index}: ${url}`, err);
    return null;
  }
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return `data:${blob.type || 'application/zip'};base64,${base64}`;
}
