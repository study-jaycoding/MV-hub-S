export const USAGE_PAGE_SIZES = [5, 10, 25] as const;

export interface UsagePage<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalPages: number;
}

export function paginateUsageItems<T>(
  items: T[],
  requestedPage: number,
  requestedPageSize: number,
): UsagePage<T> {
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.max(1, Math.floor(requestedPageSize))
    : USAGE_PAGE_SIZES[0];
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const normalizedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(totalPages, Math.max(1, normalizedPage));
  const start = (page - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalPages,
  };
}
