import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const shots = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/screenshots');
mkdirSync(shots, { recursive: true });

async function person(context: BrowserContext, name: string, color: string, semantic = false): Promise<Page> {
  await context.addInitScript(
    ({ n, c, s }) => {
      if (!localStorage.getItem('tandem.user')) localStorage.setItem('tandem.user', JSON.stringify({ name: n, color: c }));
      localStorage.setItem('tandem.semantic', s);
    },
    { n: name, c: color, s: semantic ? 'on' : 'off' },
  );
  return context.newPage();
}

const editor = (p: Page) => p.locator('.editor .ProseMirror');
const pageText = (p: Page) =>
  p.evaluate(() => {
    const ws = (window as unknown as { tandem: { page(id: string): { text: string } | undefined } }).tandem;
    return ws.page(location.hash.split('/')[3]!)!.text;
  });

async function newPage(p: Page, title: string, body: string): Promise<void> {
  const before = p.url();
  await p.getByRole('button', { name: 'New page' }).click();
  await expect(p).not.toHaveURL(before);
  await expect(p.locator('.title')).toHaveValue('');
  await p.locator('.title').fill(title);
  await p.locator('.title').press('Enter');
  await p.keyboard.type(body, { delay: 2 });
  await expect.poll(() => pageText(p)).toBe(body);
}

test('history: browse versions, see the diff, restore with new ops that reach a collaborator', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await person(ctxA, 'Ada', '#2A3CB5');
  const basil = await person(ctxB, 'Basil', '#9A2B3B');

  await ada.goto('/');
  await expect(ada.locator('.status')).toHaveAttribute('data-status', 'synced');
  await newPage(ada, 'Opening line', 'It was a bright cold day in April.');
  await ada.getByRole('button', { name: 'Share' }).click();
  const link = await ada.getByTestId('edit-link').inputValue();
  await ada.keyboard.press('Escape');

  // Basil rewrites the sentence.
  await basil.goto(link);
  await basil.getByRole('link', { name: 'Opening line' }).click();
  await expect(editor(basil)).toContainText('bright cold day');
  await editor(basil).click();
  await basil.keyboard.press('Control+End');
  await expect.poll(() => basil.evaluate(() => getSelection()?.focusOffset)).toBe(34);
  for (let i = 0; i < 'cold day in April.'.length; i++) await basil.keyboard.press('Backspace');
  await basil.keyboard.type('warm evening in June, and the clocks were silent.', { delay: 5 });
  await expect.poll(() => pageText(ada)).toBe('It was a bright warm evening in June, and the clocks were silent.');

  // Ada opens the history and goes back to her own version.
  await ada.getByRole('button', { name: 'History' }).click();
  await expect(ada.locator('.history-label')).toContainText('after an edit by Ada');
  await expect(ada.locator('.history-text del')).toHaveText('cold day in April.');
  await expect(ada.locator('.history-text ins')).toHaveText('warm evening in June, and the clocks were silent.');
  await ada.screenshot({ path: `${shots}/history.png` });

  await ada.getByRole('button', { name: 'Restore this version' }).click();
  await expect(ada.locator('.toast')).toContainText('Restored version');
  const restored = 'It was a bright cold day in April.';
  await expect.poll(() => pageText(ada)).toBe(restored);
  await expect.poll(() => pageText(basil)).toBe(restored);
  await expect(editor(basil)).toHaveText(restored);

  // Nothing was rewritten: Basil's rewrite is still in the history.
  await basil.getByRole('button', { name: 'History' }).click();
  await basil.locator('.history-slider').press('End');
  await expect(basil.locator('.history-label')).toHaveText('Current version');
  await basil.locator('.history-slider').press('ArrowLeft');
  await expect(basil.locator('.history-text ins')).toHaveText('cold day in April.');

  await ctxA.close();
  await ctxB.close();
});

test('search: keyword results without the model, and the privacy note', async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await person(ctx, 'Iris', '#1E7A5B');
  await p.goto('/');
  await newPage(p, 'Garage', 'Service the car before winter. New tyres.');
  await p.keyboard.press('Control+k');
  await p.getByLabel('Search your notes').fill('tyres');
  await expect(p.locator('.palette-results li').first()).toContainText('Garage');
  await expect(p.locator('.palette-results li').first()).toContainText('Matching words');
  await expect(p.locator('.privacy')).toHaveText('Search runs on this device. Your notes are never sent anywhere.');
  await expect(p.locator('.palette-foot')).toContainText('Matching words only');
  await p.keyboard.press('Enter');
  await expect(p.locator('.title')).toHaveValue('Garage');
  await ctx.close();
});

test('search: semantic results from the on-device model, also offline after the first download', async ({ browser }) => {
  test.skip(!!process.env.CI, 'downloads the embedding model (~23 MB) from the Hugging Face CDN');
  test.setTimeout(240_000);
  const ctx = await browser.newContext();
  const p = await person(ctx, 'Otto', '#A87413', true);
  await p.goto('/');
  const modelState = () =>
    p.evaluate(() => (window as unknown as { tandemSearch?: { modelStatus: { state: string } } }).tandemSearch?.modelStatus.state ?? 'none');

  await newPage(p, 'Garage', 'Service the car before winter.\nNew tyres and an oil change.');
  await newPage(p, 'Sourdough', 'Feed the starter the night before.\nBake at 240 degrees with steam.');
  await newPage(p, 'Summer plans', 'Flights to Lisbon in June.\nThree days in Alfama, then the coast.');
  await newPage(p, 'Packing for the holiday', 'Passport, sunscreen, a light jacket.\nTravel adapter for the plugs.');
  await expect.poll(modelState, { timeout: 180_000 }).toBe('ready');

  // No shared words with the "Garage" page: found by meaning.
  await p.keyboard.press('Control+k');
  await p.getByLabel('Search your notes').fill('vehicle maintenance');
  await expect(p.locator('.palette-results li').first()).toContainText('Garage', { timeout: 20_000 });
  await expect(p.locator('.palette-results li').first()).toContainText('Similar meaning');
  await expect(p.locator('.palette-foot')).toContainText('Finds notes by meaning as well as by words.');
  await p.screenshot({ path: `${shots}/search.png` });
  await p.keyboard.press('Escape');

  // Related notes on a travel page point at the other travel page.
  await p.getByRole('link', { name: 'Packing for the holiday' }).click();
  await expect(p.locator('.related a').first()).toHaveText('Summer plans', { timeout: 20_000 });
  await p.screenshot({ path: `${shots}/related.png` });

  // Offline after the first download: reload with no network, the model
  // loads from the browser cache and meaning-based search still works.
  await ctx.setOffline(true);
  await p.reload();
  await expect.poll(modelState, { timeout: 60_000 }).toBe('ready');
  await p.keyboard.press('Control+k');
  await p.getByLabel('Search your notes').fill('baking bread');
  await expect(p.locator('.palette-results li').first()).toContainText('Sourdough', { timeout: 20_000 });
  await ctx.close();
});
