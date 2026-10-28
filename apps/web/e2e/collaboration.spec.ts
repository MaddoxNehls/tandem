import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const shots = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/screenshots');
mkdirSync(shots, { recursive: true });

async function person(context: BrowserContext, name: string, color: string): Promise<Page> {
  await context.addInitScript(
    ([n, c]) => {
      if (!localStorage.getItem('tandem.user')) localStorage.setItem('tandem.user', JSON.stringify({ name: n, color: c }));
    },
    [name, color],
  );
  return context.newPage();
}

const editor = (p: Page) => p.locator('.editor .ProseMirror');
const status = (p: Page) => p.locator('.status');

/** Text of the open page according to the CRDT (not the DOM). */
const crdtText = (p: Page) =>
  p.evaluate(() => {
    const ws = (window as unknown as { tandem: { page(id: string): { text: string } | undefined } }).tandem;
    const id = location.hash.split('/')[3]!;
    return ws.page(id)!.text;
  });

/** Editor DOM text (lines joined by newlines), ignoring collaborators' caret labels. */
const domText = (p: Page) =>
  p.evaluate(() =>
    Array.from(document.querySelectorAll('.editor .ProseMirror > p'))
      .map((line) => {
        const copy = line.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('.rcaret').forEach((c) => c.remove());
        return copy.textContent ?? '';
      })
      .join('\n'),
  );

/** Wait until the newly created page is open (its title is still empty). */
async function newPageOpened(p: Page, before: string): Promise<void> {
  await expect(p).not.toHaveURL(before);
  await expect(p.locator('.title')).toHaveValue('');
}

async function typeAtEnd(p: Page, text: string): Promise<void> {
  await editor(p).click();
  await p.keyboard.press('Control+End');
  // Ctrl+End moves the browser's selection; the editor learns about it from
  // the async 'selectionchange' event. A person can't press the next key
  // within the same millisecond, so wait until the caret is really at the end.
  await expect
    .poll(() =>
      p.evaluate(() => {
        const sel = getSelection();
        const last = document.querySelector('.editor .ProseMirror > p:last-child');
        return !!sel?.focusNode && !!last?.contains(sel.focusNode) && sel.focusOffset === (sel.focusNode.textContent ?? '').length;
      }),
    )
    .toBe(true);
  await p.waitForTimeout(30);
  await p.keyboard.type(text, { delay: 15 });
}

test('two people write together, see each other, and merge offline edits', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await person(ctxA, 'Ada', '#2A3CB5');
  const basil = await person(ctxB, 'Basil', '#9A2B3B');

  // Ada starts a fresh notebook: it is created locally, then claimed on the server.
  await ada.goto('/');
  await expect(ada.locator('.title')).toHaveValue('Welcome to Tandem');
  await expect(status(ada)).toHaveAttribute('data-status', 'synced');

  // Ada writes a page of her own.
  const welcomeUrl = ada.url();
  await ada.getByRole('button', { name: 'New page' }).click();
  await newPageOpened(ada, welcomeUrl);
  await ada.locator('.title').fill('Trip to Lisbon');
  await ada.locator('.title').press('Enter');
  // Enter continues a list (the marker is inserted for you) and Enter on an
  // empty item ends it, so the typed text has no repeated markers.
  await ada.keyboard.type('Three days, mostly on foot. Pack light.\n# Before we go\n[ ] book the Alfama flat\ntram 28 tickets\n', { delay: 5 });
  await ada.keyboard.press('Enter');
  await ada.keyboard.type('- comfortable shoes\na paper map\n', { delay: 5 });
  await ada.keyboard.press('Enter');
  await ada.keyboard.type('# Ideas\nLunch at the market hall, then the long walk up to the castle.', { delay: 5 });
  await expect.poll(() => crdtText(ada)).toBe(
    [
      'Three days, mostly on foot. Pack light.',
      '# Before we go',
      '[ ] book the Alfama flat',
      '[ ] tram 28 tickets',
      '- comfortable shoes',
      '- a paper map',
      '# Ideas',
      'Lunch at the market hall, then the long walk up to the castle.',
    ].join('\n'),
  );
  await expect(status(ada)).toHaveAttribute('data-status', 'synced');
  await ada.screenshot({ path: `${shots}/editor.png` });

  // Share an edit link with Basil.
  await ada.getByRole('button', { name: 'Share' }).click();
  const link = await ada.getByTestId('edit-link').inputValue();
  await ada.keyboard.press('Escape');
  expect(link).toMatch(/#\/w\/[a-z0-9]+\?t=edit\./);

  await basil.goto(link);
  await basil.getByRole('link', { name: 'Trip to Lisbon' }).click();
  await expect(editor(basil)).toContainText('Lunch at the market hall');

  // Basil edits; Ada sees the text and his cursor.
  await editor(basil).getByText('a paper map').click();
  await basil.keyboard.press('End');
  await basil.keyboard.type('\nsunscreen, it is still hot in October', { delay: 10 });
  await expect(editor(ada)).toContainText('sunscreen, it is still hot');
  // The edit must land where Basil's caret was, not merely somewhere in the doc.
  expect(await crdtText(basil)).toContain('- a paper map\n- sunscreen, it is still hot in October');
  expect(await crdtText(ada)).toBe(await crdtText(basil));
  await expect(ada.locator('.rcaret-name', { hasText: 'Basil' })).toBeVisible();

  // Ada ticks a to-do and keeps typing; Basil sees both, and Ada's cursor.
  await ada.locator('.mk-todo').first().click();
  await typeAtEnd(ada, ' Sunset at the miradouro.');
  await expect(basil.locator('.mk-done')).toHaveCount(1);
  await expect(editor(basil)).toContainText('Sunset at the miradouro.');
  await expect(basil.locator('.rcaret-name', { hasText: 'Ada' })).toBeVisible();
  await expect(ada.locator('.peers')).toContainText('Basil');

  // A selection on Basil's side shows up as a highlighted range for Ada.
  await editor(basil).getByText('comfortable shoes').click();
  await basil.keyboard.press('End');
  for (let i = 0; i < 'shoes'.length; i++) await basil.keyboard.press('Shift+ArrowLeft');
  expect(await basil.evaluate(() => String(getSelection()))).toBe('shoes');
  await expect(ada.locator('.rsel')).toHaveText('shoes');
  await ada.screenshot({ path: `${shots}/collaboration-ada.png` });
  await basil.screenshot({ path: `${shots}/collaboration-basil.png` });

  // Basil goes offline and keeps writing; Ada writes too.
  await ctxB.setOffline(true);
  await expect(status(basil)).toHaveAttribute('data-status', 'offline');
  await typeAtEnd(basil, '\nWritten on the train, offline.');
  await typeAtEnd(ada, '\nAda, still online.');
  // Ctrl+End must reach the real end even with a collaborator's caret there.
  expect(await crdtText(basil)).toMatch(/miradouro\.\nWritten on the train, offline\.$/);
  expect(await crdtText(ada)).toMatch(/miradouro\.\nAda, still online\.$/);
  await expect(editor(ada)).not.toContainText('Written on the train');
  await expect(editor(basil)).not.toContainText('Ada, still online');
  await basil.screenshot({ path: `${shots}/offline.png` });

  // Reconnect: both sides catch up and converge.
  await ctxB.setOffline(false);
  await expect(status(basil)).toHaveAttribute('data-status', 'synced');
  await expect(editor(ada)).toContainText('Written on the train, offline.');
  await expect(editor(basil)).toContainText('Ada, still online.');
  await expect.poll(async () => (await crdtText(ada)) === (await crdtText(basil))).toBe(true);
  // Each editor shows exactly its CRDT's text.
  expect(await domText(ada)).toBe(await crdtText(ada));
  expect(await domText(basil)).toBe(await crdtText(basil));

  // Reload restores instantly from IndexedDB, before any network round trip.
  await ctxB.setOffline(true);
  await basil.reload();
  await expect(editor(basil)).toContainText('Written on the train, offline.');
  await expect(status(basil)).toHaveAttribute('data-status', 'offline');
  await ctxB.setOffline(false);

  await ctxA.close();
  await ctxB.close();
});

test('a view-only link can read live but cannot write', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxV = await browser.newContext();
  const owner = await person(ctxA, 'Iris', '#1E7A5B');
  const viewer = await person(ctxV, 'Otto', '#A87413');

  await owner.goto('/');
  await expect(status(owner)).toHaveAttribute('data-status', 'synced');
  await owner.getByRole('button', { name: 'Share' }).click();
  const viewLink = await owner.getByTestId('view-link').inputValue();
  await owner.keyboard.press('Escape');

  await viewer.goto(viewLink);
  await expect(viewer.locator('.badge')).toHaveText('View only');
  await expect(editor(viewer)).toHaveAttribute('contenteditable', 'false');
  await expect(viewer.getByRole('button', { name: 'New page' })).toHaveCount(0);

  await typeAtEnd(owner, '\nLive for readers too.');
  await expect(editor(viewer)).toContainText('Live for readers too.');

  await ctxA.close();
  await ctxV.close();
});

test('moving a page inside its own subpage is refused with a message', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await person(ctx, 'Cleo', '#6A3E9E');
  await page.goto('/');
  await expect(page.locator('.title')).toHaveValue('Welcome to Tandem');

  // Create a child under the welcome page.
  const welcomeRow = page.locator('.tree-row', { hasText: 'Welcome to Tandem' });
  await welcomeRow.hover();
  const before = page.url();
  await welcomeRow.getByRole('button', { name: /Add a page inside/ }).click();
  await newPageOpened(page, before);
  await page.locator('.title').fill('Packing list');
  await expect(page.locator('.tree .tree .tree-row', { hasText: 'Packing list' })).toBeVisible();

  // Drag the parent onto its own child.
  await welcomeRow.locator('a').dragTo(page.locator('.tree-row', { hasText: 'Packing list' }));
  await expect(page.locator('.toast')).toContainText("can't be moved inside one of its own subpages");

  // Dragging the child to the top level works.
  await page.locator('.tree-row', { hasText: 'Packing list' }).locator('a').dragTo(page.locator('.new-page'));
  await expect(page.locator('.tree-root > .tree > li > .tree-row', { hasText: 'Packing list' })).toBeVisible();
  await ctx.close();
});
