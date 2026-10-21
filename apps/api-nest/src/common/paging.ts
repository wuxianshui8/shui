/** 统一分页（与参考实现 core/paging.js 语义一致：默认 300 / 上限 500） */
export function paging(query: any, opts: { defaultSize?: number; maxSize?: number } = {}) {
  const defaultSize = opts.defaultSize ?? 300;
  const maxSize = opts.maxSize ?? 500;
  const page = Math.max(1, Number(query?.page) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number(query?.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pagedResult(list: any[], total: number, pg: { page: number; pageSize: number }) {
  return {
    list,
    total,
    page: pg.page,
    pageSize: pg.pageSize,
    pages: Math.max(1, Math.ceil(total / pg.pageSize)),
  };
}
