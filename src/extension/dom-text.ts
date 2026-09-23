// "What does a human actually see in this element?" — the one answer the feed adapter and the reading
// mode article extractor both need. It lived in adapters/generic.ts until reading mode asked the same
// question (design addendum §5.1 defines its candidate rule as "the generic adapter's visibleText
// rules"), and a second copy would drift from the first the moment either one learned a new way for a
// page to hide something. Pure DOM: no chrome.*, no layout (jsdom has none), structural only.

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
// `\b` after none/hidden rejects "display:nonesuch"/"visibility:hiddenpopup" while still matching
// "display: none !important" (a boundary sits between "e" and " "/end-of-string either way).
const HIDDEN_STYLE = /display\s*:\s*none\b|visibility\s*:\s*hidden\b/i;

/** Counts `visibleText` calls since the last `__domText.resetWalks()`; read only by the generic
 * adapter's unit test, which pins down "each element's text is walked once per scan". */
let textWalks = 0;

export function isHidden(el: Element): boolean {
  return (
    SKIPPED_TAGS.has(el.tagName) ||
    el.hasAttribute('hidden') ||
    el.getAttribute('aria-hidden') === 'true' ||
    HIDDEN_STYLE.test(el.getAttribute('style') ?? '')
  );
}

// `root`'s text minus script/style/noscript/template subtrees and minus any hidden/aria-hidden/
// inline-hidden element's subtree. Iterative (an explicit stack of {nodes, i} frames, not recursion)
// so an unusually deep chain of wrapper elements can't blow the call stack; each frame resumes exactly
// where it left off once the child it just pushed is fully drained, which visits nodes in the same
// document order recursion would.
export function visibleText(root: Element): string {
  textWalks += 1;
  if (isHidden(root)) return '';
  const parts: string[] = [];
  const stack: Array<{ nodes: NodeListOf<ChildNode>; i: number }> = [{ nodes: root.childNodes, i: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.nodes.length) {
      stack.pop();
      continue;
    }
    const child = frame.nodes[frame.i++];
    if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent ?? '');
    else if (child.nodeType === Node.ELEMENT_NODE && !isHidden(child as Element)) {
      stack.push({ nodes: (child as Element).childNodes, i: 0 });
    }
  }
  return parts.join('');
}

export function collapsedText(el: Element): string {
  return visibleText(el).replace(/\s+/g, ' ').trim();
}

/** Test hook only: the walk counter, and a way to zero it between tests. Never read by production
 * code — `__generic.textWalks()`/`__generic.reset()` forward to it so the adapter's existing hook
 * keeps working unchanged. */
export const __domText = {
  walks: (): number => textWalks,
  resetWalks(): void {
    textWalks = 0;
  },
};
