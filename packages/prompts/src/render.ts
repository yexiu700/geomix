const TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * 用调用方传入的变量替换 `{{name}}` 占位符。
 * 未提供的名字保持原样，方便作者发现漏填。系统模板正文不在本骨架里。
 */
export function renderPrompt(template: string, vars: Record<string, string | number>): string {
  return template.replace(TOKEN, (match, key: string) => {
    const value = vars[key];
    if (value === undefined) return match;
    return String(value);
  });
}
