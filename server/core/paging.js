// 列表分页助手：默认值与原有 LIMIT 保持一致（向后兼容），显式传 page/pageSize 时启用翻页
export function paging(ctx, { defaultSize = 300, maxSize = 500 } = {}) {
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number(ctx.query.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pagedResult(list, total, { page, pageSize }) {
  return { list, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}