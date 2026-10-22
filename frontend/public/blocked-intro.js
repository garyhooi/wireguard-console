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

  // Phase 1 holds the animation long enough to read, then fades it to clean
  // dark. Phase 2 removes the intro from the DOM and only then fades in the
  // card + backdrop. Sequential (never overlapping) so Safari cannot leave a
  // ghost of the intro grid over the translucent card.
  var HOLD_MS = 2400;
  var FADE_OUT_MS = 300;

  function reveal() {
    root.classList.add('wgc-intro-out');
    window.setTimeout(function () {
      var el = document.getElementById('block-intro');
      if (el && el.parentNode) el.parentNode.removeChild(el);
      root.classList.remove('wgc-intro');
      root.classList.remove('wgc-intro-out');
    }, FADE_OUT_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      window.setTimeout(reveal, HOLD_MS);
    });
  } else {
    window.setTimeout(reveal, HOLD_MS);
  }
})();
