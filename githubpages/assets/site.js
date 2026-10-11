/* Small, optional enhancements. Navigation and full-size images are real links. */
(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const menuButton = document.querySelector('.menu-toggle');
  const navigation = document.querySelector('#site-nav');
  function closeMenu(restoreFocus = false) {
    if (!menuButton || !navigation) return;
    navigation.classList.remove('is-open');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.textContent = 'Menu';
    if (restoreFocus) menuButton.focus();
  }
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.textContent = open ? 'Close' : 'Menu';
    navigation?.classList.toggle('is-open', open);
  });
  navigation?.addEventListener('click', event => {
    if (event.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menuButton?.getAttribute('aria-expanded') === 'true') closeMenu(true);
  });
  const wideScreen = matchMedia('(min-width: 761px)');
  wideScreen.addEventListener('change', event => { if (event.matches) closeMenu(); });

  document.querySelectorAll('.copy-button[data-copy-target]').forEach(button => {
    const block = button.closest('.code-block');
    const status = document.createElement('span');
    status.className = 'copy-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    block?.append(status);
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(target.textContent.trim());
        button.textContent = 'Copied';
        status.textContent = 'Command copied to your clipboard.';
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        selection?.removeAllRanges();
        selection?.addRange(range);
        button.textContent = 'Select & copy';
        status.textContent = 'Automatic copy is unavailable. The command is selected; copy it with your keyboard or touch menu.';
      }
    });
  });

  const imageLinks = document.querySelectorAll('a[data-zoom]');
  if (!imageLinks.length) return;
  function screenshotUrl(link) {
    // Check the raw path before URL normalization can hide traversal, whitespace
    // or protocol payloads. Screenshots are local raster files, not arbitrary URLs.
    const source = link.getAttribute('href');
    if (!source || source !== source.trim() || !/^(?:\/|\.\/)?(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif|avif)$/i.test(source)) return null;
    const url = new URL(source, window.location.href);
    if (!/^https?:$/.test(url.protocol) || url.origin !== window.location.origin || link.href !== url.href) return null;
    return url.href;
  }
  const dialog = document.createElement('dialog');
  const supportsDialog = typeof dialog.showModal === 'function';
  dialog.className = 'screenshot-dialog';
  dialog.setAttribute('aria-label', 'Full-size screenshot');
  dialog.innerHTML = '<div class="dialog-toolbar"><a class="original-link" target="_blank" rel="noopener">Open original image ↗</a><button type="button" autofocus>Close <span aria-hidden="true">×</span></button></div><img alt=""><p id="screenshot-caption"></p>';
  dialog.setAttribute('aria-describedby', 'screenshot-caption');
  if (supportsDialog) document.body.append(dialog);
  const image = dialog.querySelector('img');
  const caption = dialog.querySelector('p');
  const original = dialog.querySelector('.original-link');
  let trigger;
  imageLinks.forEach(link => link.addEventListener('click', event => {
    const source = screenshotUrl(link);
    if (!source) { event.preventDefault(); return; }
    if (!supportsDialog || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    trigger = link;
    image.src = source;
    image.alt = link.querySelector('img')?.alt || 'FLUJO screenshot';
    caption.textContent = link.closest('figure')?.querySelector('figcaption span')?.textContent || image.alt;
    original.href = source;
    dialog.showModal();
    document.body.classList.add('no-scroll');
  }));
  imageLinks.forEach(link => link.addEventListener('auxclick', event => {
    if (!screenshotUrl(link)) event.preventDefault();
  }));
  if (!supportsDialog) return;
  dialog.querySelector('button').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const close = dialog.querySelector('button');
    if (event.shiftKey && document.activeElement === original) {
      event.preventDefault();
      close.focus();
    } else if (!event.shiftKey && document.activeElement === close) {
      event.preventDefault();
      original.focus();
    }
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('no-scroll');
    trigger?.focus();
  });
})();
