const TEXT_INPUT_TYPES = new Set([
  "",
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

const INPUT_ASSISTANCE_ATTRIBUTES = {
  autocapitalize: "off",
  autocomplete: "off",
  autocorrect: "off",
  spellcheck: "false",
} as const;

type AssistedInput = HTMLInputElement | HTMLTextAreaElement;

const isAssistedInput = (element: Element): element is AssistedInput => {
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return TEXT_INPUT_TYPES.has(element.type.toLowerCase());
};

const disableInputAssistance = (element: AssistedInput) => {
  for (const [name, value] of Object.entries(INPUT_ASSISTANCE_ATTRIBUTES)) {
    element.setAttribute(name, value);
  }
  element.spellcheck = false;
};

const disableInputAssistanceIn = (root: ParentNode) => {
  if (root instanceof Element && isAssistedInput(root)) {
    disableInputAssistance(root);
  }

  root.querySelectorAll("input, textarea").forEach((element) => {
    if (isAssistedInput(element)) {
      disableInputAssistance(element);
    }
  });
};

export function installInputAssistanceDisabler() {
  disableInputAssistanceIn(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          disableInputAssistanceIn(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  return () => observer.disconnect();
}
