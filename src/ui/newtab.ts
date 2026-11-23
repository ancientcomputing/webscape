// Pick the start page's look from the URL hash (#legacy), set before first paint.
// Loaded as a classic script (not a module) so it runs before the body renders.
const applyLook = () => document.documentElement.classList.toggle('legacy', location.hash === '#legacy');
applyLook();
// Switching looks only changes the hash, which doesn't reload the page.
window.addEventListener('hashchange', applyLook);
