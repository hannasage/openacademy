/** Keep browser tests inside their isolated local server. */
export async function isolateContext(context, origin, {mockLearningWrites = false} = {}) {
  const blockedOrigins = [];
  await context.route('**/*', async route => {
    const address = new URL(route.request().url());
    if (address.origin !== origin) {
      blockedOrigins.push(address.origin);
      return route.abort('blockedbyclient');
    }
    if (address.pathname === '/api/cloud-config') return route.fulfill({json: {}});
    if (mockLearningWrites && address.pathname.startsWith('/api/') && route.request().method() !== 'GET') {
      const state = route.request().postDataJSON();
      if (state.record) return route.fulfill({json: {...state.record, state: {...state.record.state, revision: state.expectedRevision + 1}}});
      return route.fulfill({json: {...state, revision: (state.revision || 0) + 1}});
    }
    return route.continue();
  });
  // No browser suite requires a socket connection, including one to Supabase.
  await context.routeWebSocket('**/*', socket => socket.close());
  return blockedOrigins;
}
