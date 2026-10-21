// 规则配置读写（带内存缓存，变更后失效）
import { all, get, run } from "./db.js";
import { DEFAULT_RULES } from "./defaults.js";
import { nowIso } from "./ids.js";

const cache = new Map();

export function ensureDefaults() {
  for (const [key, def] of Object.entries(DEFAULT_RULES)) {
    const exist = get("SELECT key FROM rule_configs WHERE key = ?", key);
    if (!exist) {
      run(
        "INSERT INTO rule_configs (key, grp, label, value, editable, updated_at) VALUES (?,?,?,?,1,?)",
        key,
        def.grp,
        def.label,
        JSON.stringify(def.value),
        nowIso()
      );
    }
  }
}

export function rule(key) {
  if (cache.has(key)) return cache.get(key);
  const row = get("SELECT value FROM rule_configs WHERE key = ?", key);
  const val = row ? JSON.parse(row.value) : DEFAULT_RULES[key]?.value;
  cache.set(key, val);
  return val;
}

export function setRule(key, value, actorId = null) {
  const def = DEFAULT_RULES[key];
  const grp = def?.grp ?? "自定义";
  const label = def?.label ?? key;
  const exist = get("SELECT key FROM rule_configs WHERE key = ?", key);
  if (exist) {
    run(
      "UPDATE rule_configs SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?",
      JSON.stringify(value),
      actorId,
      nowIso(),
      key
    );
  } else {
    run(
      "INSERT INTO rule_configs (key, grp, label, value, editable, updated_by, updated_at) VALUES (?,?,?,?,1,?,?)",
      key,
      grp,
      label,
      JSON.stringify(value),
      actorId,
      nowIso()
    );
  }
  cache.delete(key);
  return value;
}

export function listRules() {
  return all("SELECT key, grp, label, value, editable, updated_at FROM rule_configs ORDER BY grp, key").map(
    (r) => ({ ...r, value: JSON.parse(r.value) })
  );
}

export function invalidate() {
  cache.clear();
}