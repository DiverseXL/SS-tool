import type { Fetcher } from './fetcher.js';

export interface RobotsPolicy {
  url: string;
  ruleCount: number;
  behaviour: 'parsed' | 'unavailable' | 'forbidden';
  isAllowed(url: URL | string): boolean;
}

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

function parseGroups(contents: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastDirective: 'agent' | 'rule' | undefined;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'user-agent') {
      if (!current || lastDirective === 'rule') {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastDirective = 'agent';
      continue;
    }

    if ((key === 'allow' || key === 'disallow') && current && lastDirective) {
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
      lastDirective = 'rule';
    }
  }

  return groups;
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const expression = new RegExp(`^${escaped}${anchored ? '$' : ''}`);
  return expression.test(path);
}

function compileRules(groups: RobotsGroup[]): RobotsRule[] {
  const matching = groups.filter((group) =>
    group.agents.some((agent) => agent === '*' || 'ss-tool-research'.includes(agent) || agent.includes('ss-tool-research')),
  );

  return matching.flatMap((group) => group.rules);
}

function allows(path: string, rules: RobotsRule[]): boolean {
  let best: { length: number; allow: boolean } | undefined;

  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, path)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { length, allow: rule.allow };
    }
  }

  return best ? best.allow : true;
}

/**
 * Fetches and compiles robots.txt for one origin. The request is made through
 * the safe fetcher and does not count against the per-research page budget.
 * A missing or unreadable robots.txt allows access; explicit 401/403 forbids it.
 */
export async function loadRobotsPolicy(origin: URL, fetcher: Fetcher): Promise<RobotsPolicy> {
  const robotsUrl = new URL('/robots.txt', origin).href;

  const allowAll = (behaviour: RobotsPolicy['behaviour']): RobotsPolicy => ({
    url: robotsUrl,
    ruleCount: 0,
    behaviour,
    isAllowed: () => true,
  });

  let result;
  try {
    result = await fetcher.fetch(robotsUrl, { maxBytes: 512 * 1024, allowNonHtml: true });
  } catch {
    return allowAll('unavailable');
  }

  if (result.status === 401 || result.status === 403) {
    return {
      url: robotsUrl,
      ruleCount: 0,
      behaviour: 'forbidden',
      isAllowed: () => false,
    };
  }

  if (result.status < 200 || result.status >= 300) {
    return allowAll('unavailable');
  }

  const rules = compileRules(parseGroups(result.body));

  return {
    url: robotsUrl,
    ruleCount: rules.length,
    behaviour: 'parsed',
    isAllowed: (url) => {
      const target = typeof url === 'string' ? new URL(url) : url;
      return allows(`${target.pathname}${target.search}`, rules);
    },
  };
}
