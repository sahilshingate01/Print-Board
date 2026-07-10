/**
 * Printboard - Content Script
 * 
 * Injected into Pinterest pages to:
 * 1. Auto-scroll search results to load more pins
 * 2. Extract high-resolution image URLs from pins
 * 3. Report progress back to background script
 * 4. Support stop commands
 * 
 * Pinterest renders images in various formats:
 * - Thumbnails: 236px wide
 * - Medium: 564px or 736px wide
 * - Originals: full resolution
 * 
 * We upgrade URLs to get the highest resolution available.
 */

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__printboard_injected) return;
  window.__printboard_injected = true;

  // Keep background script alive by pinging every 20 seconds
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: 'keep-alive' });
    } catch (e) {}
  }, 20000);

  let shouldStop = false;
  let isScrapingActive = false;

  // ── Message Listener ──
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'start-scraping') {
      if (isScrapingActive) {
        sendResponse({ error: 'Already scraping' });
        return true;
      }

      isScrapingActive = true;
      shouldStop = false;

      // Run async scraping
      scrapeImages(message.maxImages, message.scrollDelay)
        .then((images) => {
          isScrapingActive = false;
          sendResponse({ images });
        })
        .catch((err) => {
          isScrapingActive = false;
          sendResponse({ error: err.message || 'Scraping failed' });
        });

      // Return true to indicate async response
      return true;
    }

    if (message.type === 'stop-scraping') {
      shouldStop = true;
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  // ── Image Scraping ──

  async function scrapeImages(maxImages = 0, scrollDelay = 1500) {
    // maxImages = 0 means unlimited — scrape everything available
    const isUnlimited = !maxImages || maxImages <= 0;
    const collectedUrls = new Set();
    let noNewImagesCount = 0;
    const maxNoNewImages = 15; // Stop after 15 consecutive scrolls with no new images
    let scrollCount = 0;
    const maxScrolls = 500; // Very high safety limit

    // Initial collection
    collectImagesFromPage(collectedUrls);
    reportProgress(collectedUrls.size);

    // Check if Pinterest is showing the "No Pins found" screen
    const pageText = document.body.innerText || '';
    if (pageText.includes("Sorry, we couldn't find any Pins for this search") || 
        pageText.includes("we couldn't find any Pins for this search")) {
      console.log("No pins found for this search. Skipping.");
      return []; // Return empty array to skip keyword
    }

    // Scroll and collect loop — keep going until no more new images load
    while (
      (isUnlimited || collectedUrls.size < maxImages) &&
      noNewImagesCount < maxNoNewImages &&
      scrollCount < maxScrolls &&
      !shouldStop
    ) {
      const prevCount = collectedUrls.size;

      // Find the best scroll container (Pinterest sometimes uses body, sometimes window)
      const scrollElement = document.scrollingElement || document.documentElement || document.body;
      
      // Scroll down incrementally (800px) so virtualized items have time to render
      // We do this by assigning scrollTop directly, which works reliably across frameworks
      scrollElement.scrollTop += 800;

      // Also try scrolling any internal containers just in case it's a newer Pinterest layout
      const containers = document.querySelectorAll('div[style*="overflow"], div[class*="Grid"], div[role="main"]');
      for (const el of containers) {
        if (el.scrollHeight > el.clientHeight) {
          el.scrollTop += 800;
        }
      }
      
      // Wait for new content to load
      await delay(scrollDelay);

      // Also wait for any lazy images to load
      await waitForImages(500);

      // Collect new images
      collectImagesFromPage(collectedUrls);

      scrollCount++;

      if (collectedUrls.size === prevCount) {
        noNewImagesCount++;
      } else {
        noNewImagesCount = 0;
      }

      reportProgress(collectedUrls.size);

      // Slight random delay to appear more human-like
      await delay(200 + Math.random() * 300);
    }

    // Final collection pass
    collectImagesFromPage(collectedUrls);

    // Convert Set to Array — no limit, take everything
    const results = Array.from(collectedUrls);

    // Upgrade all URLs to highest resolution
    const highResUrls = results.map(upgradeToHighRes);

    return highResUrls;
  }

  // ── Image Collection ──

  function collectImagesFromPage(urlSet) {
    // Strategy 1: Get images from pin containers
    // Pinterest uses various selectors depending on their frontend version
    const imageElements = document.querySelectorAll([
      // Main pin images in search results
      'div[data-test-id="pin"] img',
      'div[data-test-id="pinWrapper"] img',
      // Alternative selectors for different Pinterest layouts
      'div[data-grid-item] img',
      'div[role="listitem"] img',
      // Broader selector for pin images
      'a[href*="/pin/"] img',
      // Image containers
      '.GrowthUnauthPinImage img',
      '.PinImage img',
      // Fallback: any noscript images that contain pinimg
      'img[src*="pinimg.com"]',
      'img[srcset*="pinimg.com"]',
    ].join(', '));

    for (const img of imageElements) {
      // Skip tiny icons, avatars, logos
      if (img.width > 0 && img.width < 50) continue;
      if (img.height > 0 && img.height < 50) continue;

      // Check for avatar/profile indicators
      if (isAvatarOrIcon(img)) continue;

      // Try srcset first (often has higher res)
      const srcsetUrl = getBestSrcsetUrl(img);
      if (srcsetUrl && isPinterestImage(srcsetUrl)) {
        urlSet.add(normalizeUrl(srcsetUrl));
        continue;
      }

      // Then src
      const src = img.src || img.getAttribute('src');
      if (src && isPinterestImage(src)) {
        urlSet.add(normalizeUrl(src));
        continue;
      }

      // Check data-src (lazy loaded)
      const dataSrc = img.dataset.src || img.getAttribute('data-src');
      if (dataSrc && isPinterestImage(dataSrc)) {
        urlSet.add(normalizeUrl(dataSrc));
      }
    }

    // Strategy 2: Check background images on div elements
    const bgElements = document.querySelectorAll('div[style*="background-image"]');
    for (const el of bgElements) {
      const style = el.style.backgroundImage;
      const match = style.match(/url\(["']?(.*?)["']?\)/);
      if (match && match[1] && isPinterestImage(match[1])) {
        // Verify it's not an avatar by checking dimensions
        const rect = el.getBoundingClientRect();
        if (rect.width > 80 && rect.height > 80) {
          urlSet.add(normalizeUrl(match[1]));
        }
      }
    }

    // Strategy 3: Check for noscript fallback images
    const noscriptElements = document.querySelectorAll('noscript');
    for (const ns of noscriptElements) {
      const html = ns.innerHTML || ns.textContent;
      const imgMatches = html.matchAll(/src=["'](https?:\/\/[^"']*pinimg\.com[^"']*)["']/gi);
      for (const m of imgMatches) {
        if (isPinterestImage(m[1])) {
          urlSet.add(normalizeUrl(m[1]));
        }
      }
    }
  }

  function isPinterestImage(url) {
    if (!url) return false;
    // Must be from Pinterest's image CDN
    return url.includes('pinimg.com') && !url.includes('/avatars/');
  }

  function isAvatarOrIcon(img) {
    // Check parent elements for avatar/profile indicators
    let el = img;
    for (let i = 0; i < 4; i++) {
      if (!el) break;
      const classes = el.className?.toLowerCase?.() || '';
      const testId = el.getAttribute?.('data-test-id') || '';
      if (
        classes.includes('avatar') ||
        classes.includes('profile') ||
        classes.includes('creator') ||
        classes.includes('pinner') ||
        testId.includes('avatar') ||
        testId.includes('profile')
      ) {
        return true;
      }
      el = el.parentElement;
    }

    // Check image dimensions
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width > 0 && width === height && width <= 100) {
      return true; // Square small images are likely avatars
    }

    return false;
  }

  function getBestSrcsetUrl(img) {
    const srcset = img.srcset || img.getAttribute('srcset');
    if (!srcset) return null;

    // Parse srcset and get the largest image
    const entries = srcset.split(',').map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      const descriptor = parts[1] || '1x';
      let size = 1;
      if (descriptor.endsWith('w')) {
        size = parseInt(descriptor) || 1;
      } else if (descriptor.endsWith('x')) {
        size = parseFloat(descriptor) || 1;
      }
      return { url, size };
    });

    // Sort by size descending
    entries.sort((a, b) => b.size - a.size);

    return entries[0]?.url || null;
  }

  // ── URL Processing ──

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      // Remove query params that are just for sizing/caching
      u.search = '';
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  function upgradeToHighRes(url) {
    // Pinterest image URL patterns:
    // https://i.pinimg.com/236x/...  (thumbnail)
    // https://i.pinimg.com/474x/...  (medium)
    // https://i.pinimg.com/564x/...  (large)
    // https://i.pinimg.com/736x/...  (larger)
    // https://i.pinimg.com/originals/...  (original - highest)
    // https://i.pinimg.com/1200x/...  (high res)
    
    // Try to upgrade to originals first, fall back to 736x
    try {
      // Replace size prefix with 'originals'
      let upgraded = url.replace(
        /\/\/(i\.pinimg\.com)\/((?:236x|474x|564x|736x|750x|1200x|60x60|170x)\/)/,
        '//$1/originals/'
      );

      // If URL already has originals or wasn't modified, try 736x
      if (upgraded === url && !url.includes('/originals/')) {
        upgraded = url.replace(
          /\/\/(i\.pinimg\.com)\/((?:236x|474x|564x|60x60|170x)\/)/,
          '//$1/736x/'
        );
      }

      return upgraded;
    } catch (e) {
      return url;
    }
  }

  // ── Progress Reporting ──

  function reportProgress(count) {
    try {
      chrome.runtime.sendMessage({
        type: 'scrape-progress',
        count: count,
      });
    } catch (e) {
      // Extension context might be invalidated
    }
  }

  // ── Utilities ──

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForImages(timeout = 1000) {
    return new Promise((resolve) => {
      const images = document.querySelectorAll('img[loading="lazy"]');
      if (images.length === 0) {
        resolve();
        return;
      }

      let loaded = 0;
      const total = images.length;
      const timer = setTimeout(resolve, timeout);

      for (const img of images) {
        if (img.complete) {
          loaded++;
          if (loaded >= total) {
            clearTimeout(timer);
            resolve();
          }
        } else {
          img.addEventListener('load', () => {
            loaded++;
            if (loaded >= total) {
              clearTimeout(timer);
              resolve();
            }
          }, { once: true });
          img.addEventListener('error', () => {
            loaded++;
            if (loaded >= total) {
              clearTimeout(timer);
              resolve();
            }
          }, { once: true });
        }
      }
    });
  }
})();
