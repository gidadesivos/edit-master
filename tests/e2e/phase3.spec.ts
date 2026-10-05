import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_DIR } from './global-setup';

const TYPES: Record<string, string> = { webm: 'video/webm', mp3: 'audio/mpeg', png: 'image/png', jpg: 'image/jpeg' };

async function dropFiles(page: Page, names: string[]) {
  await page.evaluate(async (names) => {
    const dt = new DataTransfer();
    for (const [name, type] of names) dt.items.add(new File([await (await fetch('/__media/' + name)).blob()], name, { type }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, names.map((n) => [n, TYPES[n.split('.').pop()!]]));
}

const seek = async (page: Page, t: number) => {
  await page.evaluate((t) => (window as any).__EDIT_MASTER__.useEditor.getState().setPlayhead(t), t);
  await page.waitForTimeout(400);
};

const pixel = (page: Page, fx: number, fy: number) =>
  page.evaluate(([fx, fy]) => {
    const c = document.querySelector<HTMLCanvasElement>('.stage canvas')!;
    return [...c.getContext('2d')!.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data.slice(0, 3)];
  }, [fx, fy]);

test.beforeEach(async ({ page }) => {
  await page.route('**/__media/*', (r) => r.fulfill({ body: readFileSync(join(MEDIA_DIR, r.request().url().split('/').pop()!)) }));
  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();
});

test('phase 3: chroma key and on-device background removal', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await dropFiles(page, ['green.png', 'astronaut.jpg']);
  await expect(page.locator('.asset')).toHaveCount(2);
  await page.locator('.asset', { hasText: 'green.png' }).dblclick(); // [0,5]
  await page.locator('.asset', { hasText: 'astronaut' }).dblclick(); // [5,10]

  // Blue project background makes removed areas easy to detect.
  await page.keyboard.press('Escape');
  await page.locator('.inspector input[type=color]').fill('#0000ff');

  // Chroma key on the green image.
  await page.locator('.lane.video .clip').first().click({ position: { x: 20, y: 30 } });
  await page.getByRole('tab', { name: 'Recorte' }).click();
  await page.getByLabel('Remover uma cor de fundo').check();
  await seek(page, 1);
  expect(await pixel(page, 0.1, 0.1)).toEqual([0, 0, 255]); // green → removed
  const red = await pixel(page, 0.5, 0.5);
  expect(red[0]).toBeGreaterThan(200);
  expect(red[2]).toBeLessThan(60);

  // Background removal on the portrait.
  await page.locator('.lane.video .clip').nth(1).click({ position: { x: 20, y: 30 } });
  await page.getByRole('tab', { name: 'Recorte' }).click();
  await seek(page, 6);
  // The square photo is centred in the 16:9 canvas: map photo coordinates to canvas coordinates.
  const inPhoto = (x: number, y: number) => pixel(page, (1 - 9 / 16) / 2 + (9 / 16) * x, y);
  const before = await inPhoto(0.85, 0.15); // studio backdrop beside the head
  expect(before).not.toEqual([0, 0, 255]);
  await page.getByLabel('Remover o fundo atrás de pessoas').check();
  await expect.poll(async () => { await seek(page, 6.05); return inPhoto(0.85, 0.15); }, { timeout: 30_000 }).toEqual([0, 0, 255]);
  const face = await inPhoto(0.45, 0.25);
  expect(face).not.toEqual([0, 0, 255]); // the person stays

  expect(errors).toEqual([]);
});

test('phase 3: automatic captions with Whisper', async ({ page }) => {
  test.skip(!process.env.CAPTIONS_E2E || !existsSync(join(MEDIA_DIR, 'speech.mp3')), 'needs network access and espeak-ng');
  test.setTimeout(600_000);
  await dropFiles(page, ['speech.mp3']);
  await expect(page.locator('.asset')).toHaveCount(1);
  await page.locator('.asset').dblclick();
  await page.getByRole('button', { name: 'Legendas' }).click();
  await page.locator('.modal select').nth(1).selectOption('onnx-community/whisper-tiny');
  await page.getByRole('button', { name: 'Gerar legendas' }).click();
  await expect(page.locator('.toast', { hasText: 'legendas criadas' })).toBeVisible({ timeout: 540_000 });
  const texts = await page.evaluate(() =>
    Object.values((window as any).__EDIT_MASTER__.useEditor.getState().project.clips)
      .filter((c: any) => c.kind === 'text')
      .map((c: any) => c.text.content as string),
  );
  console.log('captions:', texts);
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.join(' ').replace(/\s/g, '').length).toBeGreaterThan(5);
});
