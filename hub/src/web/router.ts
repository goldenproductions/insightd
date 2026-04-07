/**
 * Simple URL pattern router. Maps path patterns to handler functions.
 * Supports :param placeholders (e.g. /api/hosts/:hostId).
 */

interface Route {
  method: string;
  regex: RegExp;
  paramNames: string[];
  handler: Function;
}

interface MatchResult {
  handler: Function;
  params: Record<string, string>;
}

function createRouter(): { add: (method: string, pattern: string, handler: Function) => void; match: (method: string, pathname: string) => MatchResult | null } {
  const routes: Route[] = [];

  function add(method: string, pattern: string, handler: Function): void {
    const paramNames: string[] = [];
    const regexStr = pattern.replace(/:([a-zA-Z]+)/g, (_: string, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({ method, regex: new RegExp(`^${regexStr}$`), paramNames, handler });
  }

  function match(method: string, pathname: string): MatchResult | null {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.regex);
      if (m) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name: string, i: number) => { params[name] = decodeURIComponent(m[i + 1]); });
        return { handler: route.handler, params };
      }
    }
    return null;
  }

  return { add, match };
}

module.exports = { createRouter };
