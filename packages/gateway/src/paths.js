// Which request paths a gateway protects. Patterns are exact paths ("/me") or
// prefixes ("/v1/*"). Matching is deliberately generous: a path counts as
// protected if either its raw form or its canonical form matches, compared
// case-insensitively and ignoring a trailing slash, because upstream routers
// (Express included) route "/ME", "/me/" and "//me" to the same handler.

/** Lower-case, collapse repeated slashes, resolve dot segments, drop a trailing slash. */
function tidy(path) {
  const out = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return ('/' + out.join('/')).toLowerCase();
}

/** Raw and percent-decoded forms of a request path, both tidied. */
export function pathVariants(rawPath) {
  const raw = typeof rawPath === 'string' && rawPath.startsWith('/') ? rawPath : '/';
  const variants = new Set([tidy(raw)]);
  try {
    variants.add(tidy(decodeURIComponent(raw)));
  } catch {
    // Malformed percent-encoding: the raw form is all we can match on.
  }
  return [...variants];
}

/**
 * Compile `protect` patterns into a predicate over request paths.
 * @param {string[]} patterns exact paths or `prefix/*`
 * @returns {(path: string) => boolean}
 */
export function compileProtect(patterns = []) {
  const rules = patterns.map((pattern) => {
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
      throw new TypeError(`protect patterns must be paths starting with "/": ${pattern}`);
    }
    if (pattern.endsWith('/*')) {
      const prefix = tidy(pattern.slice(0, -2));
      return prefix === '/' ? { all: true } : { prefix };
    }
    return { exact: tidy(pattern) };
  });
  return (path) =>
    pathVariants(path).some((candidate) =>
      rules.some(
        (rule) =>
          rule.all ||
          candidate === rule.exact ||
          (rule.prefix && (candidate === rule.prefix || candidate.startsWith(rule.prefix + '/'))),
      ),
    );
}
