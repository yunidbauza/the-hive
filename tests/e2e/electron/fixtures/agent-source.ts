import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Driving Settings › Agents' Source tab from a browser test.
 *
 * The tab is CodeMirror, not a textarea, so the two things every spec here does
 * to it both changed shape:
 *
 * - **Filling.** `fill()` works on the content element — it is
 *   `contenteditable`, and Playwright's insert produces the `beforeinput` a
 *   real paste does, which is exactly what CodeMirror listens for.
 * - **Reading.** `toHaveValue` is for form controls and a `<div>` has no value.
 *   `toContainText` is the equivalent, with one caveat these helpers make
 *   explicit: CodeMirror renders each line as its own element and drops the
 *   newlines between them, so a pattern may not span two lines.
 *
 * One module rather than a copy per spec, because getting the caveat wrong
 * produces a test that passes for the wrong reason.
 */

/** The editable surface itself — CodeMirror's content element. */
export function agentSource(page: Page): Locator {
  return page.getByLabel('Agent source');
}

/** Replace the whole definition, as a select-all and paste would. */
export async function fillAgentSource(page: Page, text: string): Promise<void> {
  await agentSource(page).fill(text);
}

/**
 * Assert the definition contains this, **within one line**.
 *
 * A `RegExp` that spans a newline can never match here: the rendered lines are
 * separate elements and the text they concatenate to has no `\n` between them.
 */
export async function expectAgentSource(
  page: Page,
  pattern: RegExp,
): Promise<void> {
  await expect(agentSource(page)).toContainText(pattern);
}
