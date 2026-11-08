/** Cached JSON requests; a failed response is evicted so a retry can recover. */
const cache = new Map();

/** Archive references stay rooted at /data/. Resolve them at request time so
 * the same data works in a native bundle, at /, and below a Pages repo path. */
export function resolveAssetUrl(url, base = import.meta.env?.BASE_URL ?? "/") {
  if (
    typeof url !== "string" ||
    (!url.startsWith("/data/") && url !== "/mobile-package.json")
  )
    return url;
  return `${base.endsWith("/") ? base : `${base}/`}${url.slice(1)}`;
}

export async function getJSON(url) {
  const resolved = resolveAssetUrl(url);
  if (!cache.has(resolved))
    cache.set(
      resolved,
      fetch(resolved)
        .then((r) => {
          if (!r.ok)
            throw new Error(`Не удалось загрузить ${resolved} (${r.status})`);
          return r.json();
        })
        .catch((e) => {
          cache.delete(resolved);
          throw e;
        }),
    );
  return cache.get(resolved);
}
