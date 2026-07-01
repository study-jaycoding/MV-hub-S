export function toggleSetValue<T>(values: Set<T>, value: T): Set<T> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function withoutSetValue<T>(values: Set<T>, value: T): Set<T> {
  const next = new Set(values);
  next.delete(value);
  return next;
}

export function singleOrClearSet<T>(values: Set<T>, value: T): Set<T> {
  if (values.has(value) && values.size === 1) return new Set();
  return new Set([value]);
}
