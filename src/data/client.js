/** Cached JSON requests; a failed response is evicted so a retry can recover. */
const cache = new Map();
export async function getJSON(url) {
  if (!cache.has(url))
    cache.set(
      url,
      fetch(url)
        .then((r) => {
          if (!r.ok)
            throw new Error(`Не удалось загрузить ${url} (${r.status})`);
          return r.json();
        })
        .catch((e) => {
          cache.delete(url);
          throw e;
        }),
    );
  return cache.get(url);
}
