# Printboard 🚀

**Printboard** is a powerful Chrome Extension that automates the tedious process of bulk downloading high-resolution images from Pinterest. Just paste a list of keywords, choose your scroll speed, and let Printboard do the heavy lifting. It scrapes the best available image resolutions and bundles them into neat `.zip` files right to your machine.

## 🎥 Demo

<video src="https://github.com/sahilshingate01/Print-Board/raw/main/demo.mp4" width="100%" controls></video>

*(If the video does not load, you can view it by downloading `demo.mp4` from the repository or dragging and dropping the file into a GitHub issue/PR to get a hosted link).*

## ✨ Features

- **Bulk Keyword Processing:** Paste a list of keywords (one per line) and process them sequentially without manual intervention.
- **High-Resolution Upgrades:** Printboard intelligently intercepts image URLs and upgrades thumbnails to fetch the highest available resolution (`originals/` or `736x/`).
- **Smart Auto-scrolling:** Automatically scrolls through Pinterest search results to bypass lazy loading and infinite pagination.
- **On-the-fly Zipping:** Uses `JSZip` to bundle all collected images into organized `.zip` files before saving.
- **Power Management:** Automatically requests "Keep Awake" permissions to ensure your computer doesn't sleep during large batch downloads.
- **Real-time Dashboard:** Watch the progress happen in real-time with an activity log, progress bars, and status updates right in the extension popup.

## 🛠️ How It Works (Under the Hood)

1. **Manifest V3 Architecture:** Utilizes modern Chrome Extension standards, including Background Service Workers and Content Scripts.
2. **Orchestrator (`background.js`):** Manages the tabs, initiates the scraping, handles parallel image downloading, zips the files, and uses the `chrome.downloads` API to save the final archive.
3. **Scraper (`content/script.js`):** Injected into Pinterest pages. It forcefully auto-scrolls, finds images using various CSS selectors (including fallbacks in `<noscript>` tags), and sends the URLs back to the orchestrator.

## 📦 Installation

Since this extension is not yet published on the Chrome Web Store, you can install it manually (unpacked):

1. **Download or Clone** this repository to your local machine.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **"Developer mode"** by toggling the switch in the top right corner.
4. Click on **"Load unpacked"** in the top left corner.
5. Select the `Printboard` project folder.
6. The extension is now installed! Pin it to your toolbar for easy access.

## 🚀 Usage

1. Click on the Printboard extension icon in your Chrome toolbar.
2. In the text area, paste your desired search keywords (one keyword per line).
3. Select your preferred **Scroll speed** (Fast, Normal, or Slow) depending on your internet connection and Pinterest's loading speeds.
4. Click **Start Downloading**.
5. The extension will automatically open Pinterest tabs, scrape the images, and download a `.zip` file for each keyword.

> **Note:** Please use this tool responsibly and adhere to Pinterest's Terms of Service regarding rate limits and scraping.

## 🏗️ Technologies Used

- **HTML / CSS / JavaScript** (Vanilla)
- **Chrome Extension API** (Manifest V3, `chrome.tabs`, `chrome.scripting`, `chrome.downloads`, `chrome.storage`, `chrome.power`)
- **[JSZip](https://stuk.github.io/jszip/)** (For bundling images into ZIP archives)

## 📄 License

This project is for educational and personal use.
