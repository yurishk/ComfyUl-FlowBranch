let chinese = typeof navigator !== "undefined"
  && String(navigator.language || "").toLowerCase().startsWith("zh");

export function setFlowLocale(locale) {
  chinese = String(locale || "en").toLowerCase().startsWith("zh");
}

export function isChinese() {
  return chinese;
}

export function tr(zh, en) {
  return chinese ? zh : en;
}
