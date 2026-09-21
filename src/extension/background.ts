// Service worker (Manifest V3, `type: module`). Owns the DuoAgent in later tasks.
export {};

chrome.runtime.onInstalled.addListener(() => console.log('jev-duo installed'));
