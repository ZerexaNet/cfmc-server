/**
 * 结构化日志工具 — 统一 JSON 单行输出 (cfmc.md 要求 #9)
 *
 * 设计: console.log/warn/error 在 Workers 中分别映射到 stdout 的不同级别,
 * `wrangler tail --format pretty` 或 Logpush 可直接按 level 字段过滤。
 * 一律单行 JSON: 便于 jq / Datadog / Logflare 结构化查询。
 */

function emit(level, type, data) {
  const line = JSON.stringify({ level, type, at: Date.now(), ...data });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (type, data = {}) => emit('info', type, data),
  warn: (type, data = {}) => emit('warn', type, data),
  error: (type, data = {}) => emit('error', type, data),
};
