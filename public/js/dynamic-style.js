const rules = new Map();
const elementRules = new WeakMap();
let sheet;
let nextId = 0;

// Keep measured layout in an adopted stylesheet and leave the markup free of inline styles.
export function setElementStyle(element, properties) {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    new MutationObserver((changes) => {
      if (!changes.some((change) => change.removedNodes.length)) return;
      for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
        const owner = rules.get(sheet.cssRules[index]);
        if (owner.isConnected) continue;
        rules.delete(sheet.cssRules[index]);
        sheet.deleteRule(index);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  let rule = elementRules.get(element);
  if (!rule || !rules.has(rule)) {
    const id = String(++nextId);
    element.dataset.layout = id;
    const index = sheet.insertRule(`[data-layout="${id}"] {}`, sheet.cssRules.length);
    rule = sheet.cssRules[index];
    elementRules.set(element, rule);
    rules.set(rule, element);
  }
  for (const [key, value] of Object.entries(properties)) {
    if (rule.style.getPropertyValue(key) !== value) rule.style.setProperty(key, value);
  }
}
