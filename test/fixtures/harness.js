// Shared helpers for the fixture pages (see test/run.js).
(() => {
  const lines = [];
  const clean = (s) => String(s).replace(/[<>&]/g, '?');
  window.chrome = { runtime: { onMessage: { addListener() {} } } }; // content.js talks to the extension
  window.confirms = []; // texts of the confirmation dialogs, always answered yes
  window.confirm = (msg) => { window.confirms.push(String(msg)); return true; };
  // The full result is sent to the runner after every check, so a test that hangs still shows how far it got.
  const publish = (end) => navigator.sendBeacon('/__result', lines.join('\n') + (end ? '\nEND' : ''));
  window.check = (name, ok, detail = '') => {
    lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${clean(detail)})`}`);
    publish(false);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.sleep = sleep;
  // Let pending animation-frame work (the content script's observer callbacks) run.
  window.frames2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.waitFor = async (fn, ms = 15000) => {
    for (let t = 0; t < ms; t += 50) { if (fn()) return true; await sleep(50); }
    return false;
  };
  window.key = (init) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  window.press = (el, init = {}) => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };
  window.finish = (err) => {
    if (err) lines.push(`FAIL test crashed (${clean(err.stack || err)})`);
    publish(true);
  };
})();
