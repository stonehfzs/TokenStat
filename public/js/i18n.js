import { english } from './locale.en.js';

export let locale = 'zh-CN';

export function setLocale(value) {
  locale = typeof value === 'string' && /^en(?:[-_]|$)/i.test(value) ? 'en-US' : 'zh-CN';
  return locale;
}

const hanRun = /\p{Script=Han}+/gu;
const edgeWord = /[\p{Letter}\p{Number}]/u;
const punctuation = { '，': ',', '、': ',', '。': '.', '；': '.', '：': ':', '？': '?', '（': '(', '）': ')' };

export function t(text) {
  if (locale !== 'en-US' || typeof text !== 'string') return text;
  if (Object.hasOwn(english, text)) return english[text];
  let changed = false;
  const translated = text.replace(hanRun, (phrase, start) => {
    if (!Object.hasOwn(english, phrase)) return phrase;
    changed = true;
    const word = english[phrase];
    const prior = text[start - 1];
    const next = text[start + phrase.length];
    return (prior && edgeWord.test(prior) ? ' ' : '') + word + (next && edgeWord.test(next) ? ' ' : '');
  });
  if (!changed) return text;
  return translated.replace(/[，、。；：？（）]/gu, (symbol, position, input) => {
    const next = input[position + 1];
    return punctuation[symbol] + (symbol !== '（' && symbol !== '）' && next && edgeWord.test(next) ? ' ' : '');
  });
}

export function tr(strings, ...values) {
  // Only static template text is translated. Model IDs, paths and user content stay untouched.
  let result = t(strings[0]);
  for (let index = 0; index < values.length; index++) result += `${values[index]}` + t(strings[index + 1]);
  return result;
}

const attributes = ['aria-label', 'aria-description', 'aria-valuetext', 'alt', 'title', 'placeholder', 'data-tooltip'];
const verbatim = 'script, style, [translate="no"]';
const verbatimText = verbatim + ', textarea, [contenteditable]';

export function localizePage(document) {
  document.documentElement.lang = locale;
  if (locale !== 'en-US') return;
  const walker = document.createTreeWalker(document.documentElement, 4);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest(verbatimText)) node.nodeValue = t(node.nodeValue);
  }
  const selectors = attributes.map((attribute) => '[' + attribute + ']').join(', ');
  for (const element of document.querySelectorAll(selectors)) {
    if (element.closest(verbatim)) continue;
    for (const attribute of attributes) {
      if (element.hasAttribute(attribute)) element.setAttribute(attribute, t(element.getAttribute(attribute)));
    }
  }
}
