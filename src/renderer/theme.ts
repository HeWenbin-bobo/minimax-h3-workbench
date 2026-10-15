/**
 * 主题（浅色 / 深色 / 跟随系统）。
 *
 * 为什么状态只存渲染端 localStorage、不进 settingsStore：
 * 主题是纯前端的呈现偏好，进 settingsStore 就要动它的前缀归一化与 IPC 契约
 * （`.e2e/test-07-regressions.mjs` 对着那条契约断言），收益全无、风险不小。
 *
 * 写入方式：`<html data-theme="...">`。system 态不写死具体值，而是解析成实际主题后写入，
 * 并监听 `prefers-color-scheme` 变化即时重解析（否则系统切换不会跟随）。
 */

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "h3-theme";

/** 读取已保存的选择。无值时默认 system（新用户跟随系统，不强行改变他们的观感）。 */
export function loadThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
  } catch {
    // localStorage 不可用（隐私模式等）不该让整个应用起不来。
    return "system";
  }
}

export function saveThemeChoice(choice: ThemeChoice): void {
  try { localStorage.setItem(STORAGE_KEY, choice); } catch { /* 存不下就只在本次会话生效 */ }
}

/** 把选择解析成实际生效的主题。 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): "light" | "dark" {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

/** 应用到 <html data-theme>。同时同步 color-scheme，让滚动条与表单控件跟随。 */
export function applyTheme(choice: ThemeChoice, prefersDark: boolean): "light" | "dark" {
  const resolved = resolveTheme(choice, prefersDark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

/** 系统当前是否偏好深色。 */
export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

/** 三态在界面上的显示文案。 */
export function themeLabel(choice: ThemeChoice): string {
  return ({ light: "浅色", dark: "深色", system: "跟随系统" } as const)[choice];
}
