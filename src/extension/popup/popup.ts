// Popup script, bundled as an IIFE and loaded by popup.html.
export {};

const versionEl = document.getElementById('v');
if (versionEl) {
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
}
