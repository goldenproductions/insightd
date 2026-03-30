/**
 * Simple URL pattern router. Maps path patterns to handler functions.
 * Supports :param placeholders (e.g. /api/hosts/:hostId).
 */

function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const paramNames = [];
    const regexStr = pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({ method, regex: new RegExp(`^${regexStr}$`), paramNames, handler });
  }

  function match(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.regex);
      if (m) {
        const params = {};
        route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        return { handler: route.handler, params };
      }
    }
    return null;
  }

  return { add, match };
}

module.exports = { createRouter };
