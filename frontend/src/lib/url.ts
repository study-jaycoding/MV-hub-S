type QueryValue = string | number | boolean | null | undefined;

export function pathPart(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function withQuery(path: string, params: Record<string, QueryValue | QueryValue[]>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === null || item === undefined) continue;
      query.append(key, String(item));
    }
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
