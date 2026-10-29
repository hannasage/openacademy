// A local sign-in transaction cannot be completed on the hosted hub origin.
// Do not read, exchange, persist, or forward return parameters from this page.
try {
  history.replaceState(null, '', '/auth/return');
} catch {
  const notice = document.getElementById('return-privacy');
  if (notice) notice.textContent = 'The browser could not clear the sign-in address. Close this tab, then return to your Touchline app.';
}
