// Full-screen "access blocked" hologram intro for the branded block page.
//
// The block page is served under a strict Content-Security-Policy
// (script-src 'self'), so this lives in an external file. Loaded from <head>
// so the intro class lands on <html> before the card paints (no flash of the
// detail card). Without JS the card simply renders normally.
(function () {
  'use strict';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (mq && mq.matches) return; // reduced motion: show the card immediately

  root.classList.add('wgc-intro');

  // Keep the animation on screen long enough to read, then fade to the card.
  var HOLD_MS = 2400;
  var FADE_MS = 480;

  function reveal() {
    root.classList.add('wgc-intro-done');
    window.setTimeout(function () {
      root.classList.remove('wgc-intro');
    }, FADE_MS + 80);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      window.setTimeout(reveal, HOLD_MS);
    });
  } else {
    window.setTimeout(reveal, HOLD_MS);
  }
})();
