// Shared injection helper used by the service worker. Injects the content
// bundle into the tab's top frame, then invokes an action in the same
// isolated world and returns its plain result. The bundle is idempotent,
// so re-injecting before every action is safe.

export const CONTENT_FILES = ['content/env.js'];

export async function runInTab(tabId, action, arg) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (action, arg) =>
      window.UAEnvSwitcher
        ? window.UAEnvSwitcher.act(action, arg).catch(() => ({ error: 'action failed' }))
        : { error: 'not-loaded' },
    // undefined is not structured-cloneable — null is the neutral arg
    args: [action, arg === undefined ? null : arg]
  });
  const r = results && results[0];
  return r && typeof r.result === 'object' && r.result !== null ? r.result : { error: 'no-result' };
}
