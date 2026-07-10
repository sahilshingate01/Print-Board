/**
 * Printboard - Popup Script
 * Handles keyword input, communicates with background script,
 * and displays real-time progress.
 */

(function () {
  'use strict';

  // ── DOM Elements ──
  const elements = {
    inputSection: document.getElementById('inputSection'),
    progressSection: document.getElementById('progressSection'),
    keywords: document.getElementById('keywords'),

    scrollDelay: document.getElementById('scrollDelay'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    newBtn: document.getElementById('newBtn'),
    clearLog: document.getElementById('clearLog'),
    overallCount: document.getElementById('overallCount'),
    overallBar: document.getElementById('overallBar'),
    currentKeyword: document.getElementById('currentKeyword'),
    currentStatus: document.getElementById('currentStatus'),
    currentBar: document.getElementById('currentBar'),
    imageCount: document.getElementById('imageCount'),
    logContainer: document.getElementById('logContainer'),
  };

  // ── State ──
  let isRunning = false;
  let port = null;

  // ── Helpers ──

  function parseKeywords(text) {
    return text
      .split('\n')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  }

  function getTimestamp() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function addLog(message, type = '') {
    // Remove empty state message
    const empty = elements.logContainer.querySelector('.log-empty');
    if (empty) empty.remove();

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `
      <span class="log-time">${getTimestamp()}</span>
      <span class="log-msg">${escapeHtml(message)}</span>
    `;
    elements.logContainer.appendChild(entry);
    elements.logContainer.scrollTop = elements.logContainer.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function showProgress() {
    elements.inputSection.classList.add('hidden');
    elements.progressSection.classList.remove('hidden');
  }

  function showInput() {
    elements.progressSection.classList.add('hidden');
    elements.inputSection.classList.remove('hidden');
  }

  function setOverallProgress(done, total) {
    elements.overallCount.textContent = `${done} / ${total} keywords`;
    const pct = total > 0 ? (done / total) * 100 : 0;
    elements.overallBar.style.width = `${pct}%`;
  }

  function setCurrentKeyword(keyword) {
    elements.currentKeyword.textContent = keyword;
    elements.currentStatus.textContent = 'Starting...';
    elements.currentStatus.className = 'current-status';
    elements.currentBar.style.width = '0%';
    elements.imageCount.textContent = '';
  }

  function setCurrentStatus(status, statusClass = '') {
    elements.currentStatus.textContent = status;
    elements.currentStatus.className = `current-status ${statusClass}`;
  }

  function setCurrentProgress(pct) {
    elements.currentBar.style.width = `${Math.min(pct, 100)}%`;
  }

  function setImageCount(count) {
    elements.imageCount.textContent = `${count} images collected`;
  }

  function setFinished() {
    isRunning = false;
    elements.stopBtn.classList.add('hidden');
    elements.newBtn.classList.remove('hidden');
  }

  // ── Communication with Background ──

  function connectToBackground() {
    port = chrome.runtime.connect({ name: 'printboard-popup' });

    port.onMessage.addListener((msg) => {
      handleMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      port = null;
      if (isRunning) {
        addLog('Connection to background lost', 'error');
        setFinished();
      }
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'sync-state':
        if (msg.isRunning) {
          isRunning = true;
          showProgress();
          
          const state = msg.state;
          const total = state.keywords.length;
          
          setOverallProgress(state.currentIndex, total);
          setCurrentKeyword(state.currentKeyword);
          if (state.statusText) setCurrentStatus(state.statusText);
          
          if (state.downloadProgress && state.downloadProgress.total > 0) {
            setCurrentStatus(`Downloading images... (${state.downloadProgress.downloaded}/${state.downloadProgress.total})`);
            setCurrentProgress((state.downloadProgress.downloaded / state.downloadProgress.total) * 100);
          } else if (state.scrapeProgress && state.scrapeProgress.count > 0) {
            setImageCount(state.scrapeProgress.count);
            setCurrentProgress(Math.min(90, 30 + (state.scrapeProgress.count / 5)));
          }

          if (state.logs && state.logs.length > 0) {
            elements.logContainer.innerHTML = '';
            state.logs.forEach(log => {
              addLog(log.text, log.type);
            });
          }
          
          elements.startBtn.disabled = true;
          elements.stopBtn.disabled = false;
        }
        break;

      case 'keyword-start':
        setCurrentKeyword(msg.keyword);
        setOverallProgress(msg.index, msg.total);
        addLog(`Processing: "${msg.keyword}" (${msg.index + 1}/${msg.total})`, 'info');
        break;

      case 'status':
        setCurrentStatus(msg.text);
        if (msg.logType) {
          addLog(msg.text, msg.logType);
        }
        break;

      case 'scrape-progress':
        setCurrentStatus(`Scrolling & collecting images...`);
        setImageCount(msg.count);
        // Indeterminate pulsing — no fixed max in unlimited mode
        setCurrentProgress(Math.min(90, 30 + (msg.count / 5)));
        break;

      case 'download-progress':
        setCurrentStatus(`Downloading images... (${msg.downloaded}/${msg.total})`);
        setCurrentProgress((msg.downloaded / msg.total) * 100);
        break;

      case 'keyword-done':
        setCurrentStatus(`✓ Done — ${msg.imageCount} images saved`, 'done');
        setCurrentProgress(100);
        setOverallProgress(msg.index + 1, msg.total);
        addLog(`✓ "${msg.keyword}" — ${msg.imageCount} images downloaded`, 'success');
        break;

      case 'keyword-error':
        setCurrentStatus(`✗ Error: ${msg.error}`, 'error');
        addLog(`✗ "${msg.keyword}" failed: ${msg.error}`, 'error');
        setOverallProgress(msg.index + 1, msg.total);
        break;

      case 'all-done':
        setCurrentStatus('All keywords processed!', 'done');
        addLog(`🎉 All done! ${msg.successCount}/${msg.total} keywords succeeded.`, 'success');
        setOverallProgress(msg.total, msg.total);
        setFinished();
        break;

      case 'stopped':
        setCurrentStatus('Stopped by user', 'error');
        addLog('Stopped by user', 'warning');
        setFinished();
        break;

      case 'error':
        addLog(msg.text, 'error');
        if (!isRunning) setFinished();
        break;

      default:
        console.log('Unknown message:', msg);
    }
  }

  // ── Event Handlers ──

  elements.startBtn.addEventListener('click', () => {
    const keywordText = elements.keywords.value;
    const keywords = parseKeywords(keywordText);

    if (keywords.length === 0) {
      elements.keywords.focus();
      elements.keywords.style.borderColor = 'var(--error)';
      setTimeout(() => {
        elements.keywords.style.borderColor = '';
      }, 2000);
      return;
    }

    const scrollDelay = elements.scrollDelay.value;

    try {
      // Save settings
      chrome.storage.local.set({
        printboard_scrollDelay: scrollDelay,
      });
    } catch (e) {
      console.error('Storage error:', e);
    }

    isRunning = true;

    // Reset progress UI
    showProgress();
    elements.logContainer.innerHTML = '';
    elements.stopBtn.classList.remove('hidden');
    elements.newBtn.classList.add('hidden');
    setOverallProgress(0, keywords.length);

    // Connect and send command
    connectToBackground();
    
    try {
      port.postMessage({
        type: 'start',
        keywords: keywords,
        scrollDelay: scrollDelay,
      });
    } catch (err) {
      alert("Failed to connect to background script. Please try reloading the extension.");
      console.error(err);
      isRunning = false;
      return; // Stop here, don't update UI
    }

    addLog(`Starting batch: ${keywords.length} keywords, downloading all images`, 'info');
  });

  elements.stopBtn.addEventListener('click', () => {
    if (port) {
      port.postMessage({ type: 'stop' });
    }
    addLog('Stop requested...', 'warning');
  });

  elements.newBtn.addEventListener('click', () => {
    showInput();
  });

  elements.clearLog.addEventListener('click', () => {
    elements.logContainer.innerHTML = '<div class="log-empty">Ready to start...</div>';
  });

  // ── Initialization ──

  document.addEventListener('DOMContentLoaded', () => {
    connectToBackground();

    try {
      // Load saved settings
      chrome.storage.local.get(['printboard_scrollDelay'], (data) => {
        if (data.printboard_scrollDelay) {
          elements.scrollDelay.value = data.printboard_scrollDelay;
        }
      });
    } catch (e) {
      console.error('Storage error:', e);
    }
  });

})();
