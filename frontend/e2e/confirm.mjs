// The app asks for confirmation in its own box (role="alertdialog"), not the browser's. These scripts answered the
// browser's box with page.on('dialog'); this does the same for the in-app box: it records the message and clicks
// Confirm (or Cancel when told to). Use: const confirms = autoConfirm(page); ... confirms.messages(), confirms.answer('dismiss').
export function autoConfirm(page) {
  const install = () => {
    if (window.__confirmWatch) return;
    window.__confirmWatch = true; window.__dialogs = window.__dialogs ?? []; window.__answer = window.__answer ?? 'accept';
    const seen = new WeakSet();
    const check = () => {
      for (const box of document.querySelectorAll('[data-confirm]')) {
        if (seen.has(box)) continue;
        seen.add(box);
        const input = box.querySelector('input');
        window.__dialogs.push(box.textContent.replace(/(Cancel|Confirm|Save)+$/, '').trim());
        setTimeout(() => {
          if (input && window.__answer === 'accept') { window.__answerText = window.__answerText ?? 'Test template'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, window.__answerText); input.dispatchEvent(new Event('input', { bubbles: true })); }
          setTimeout(() => box.querySelector(window.__answer === 'accept' ? '[data-confirm-accept]' : '[data-confirm-cancel]')?.click(), 30);
        }, 30);
      }
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  };
  page.addInitScript(install);
  page.evaluate(install).catch(() => undefined);
  return {
    messages: () => page.evaluate(() => window.__dialogs ?? []),
    clear: () => page.evaluate(() => { window.__dialogs = []; }),
    answer: (a, text) => page.evaluate(([x, t]) => { window.__answer = x; window.__answerText = t ?? null; }, [a, text]),
  };
}
