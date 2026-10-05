import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_DIR } from './global-setup';

const TYPES: Record<string, string> = { webm: 'video/webm', mp3: 'audio/mpeg', png: 'image/png' };

async function dropFiles(page: Page, names: string[]) {
  await page.evaluate(async (names) => {
    const dt = new DataTransfer();
    for (const [name, type] of names) dt.items.add(new File([await (await fetch('/__media/' + name)).blob()], name, { type }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, names.map((n) => [n, TYPES[n.split('.').pop()!]]));
}

type Clip = { assetId: string; start: number; in: number; out: number; speed: number };
const clips = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__EDIT_MASTER__.useEditor.getState();
    return Object.values(s.project.clips) as Clip[];
  });

const centerPixel = async (page: Page, t: number) => {
  await page.evaluate((t) => (window as any).__EDIT_MASTER__.useEditor.getState().setPlayhead(t), t);
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.stage canvas')!;
    return [...c.getContext('2d')!.getImageData(c.width / 2, c.height / 2, 1, 1).data.slice(0, 3)];
  });
};

test.beforeEach(async ({ page }) => {
  await page.route('**/__media/*', (r) => r.fulfill({ body: readFileSync(join(MEDIA_DIR, r.request().url().split('/').pop()!)) }));
  // Force the download path for exports (no native save dialog in automation).
  await page.addInitScript(() => {
    (window as any).showSaveFilePicker = undefined;
  });
  // Each test gets a fresh browser context, so storage (autosave) starts empty.
  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();
});

test('import, edit, preview, undo, export and recover', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await dropFiles(page, ['clip.webm', 'square.png', 'tone.mp3']);
  await expect(page.locator('.asset')).toHaveCount(3);
  await expect(page.locator('.resolution')).toContainText('640×360'); // adopts first video's size

  for (const name of ['clip.webm', 'square.png', 'tone.mp3']) await page.locator('.asset', { hasText: name }).dblclick();
  await expect(page.locator('.clip')).toHaveCount(3);

  // Preview shows the video at 1s and the image at 6s.
  const atVideo = await centerPixel(page, 1);
  const atImage = await centerPixel(page, 6);
  expect(atImage[0]).toBeGreaterThan(230);
  expect(atImage[1]).toBeGreaterThan(140);
  expect(atImage[1]).toBeLessThan(190);
  expect(atVideo).not.toEqual(atImage);

  // Split at the playhead (6s → image and audio), then undo.
  await page.locator('.stage').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await expect(page.locator('.clip')).toHaveCount(5);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.clip')).toHaveCount(3);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.clip')).toHaveCount(5);
  await page.keyboard.press('Control+z');

  // Trim the end of the first video clip by dragging its right edge.
  const video = page.locator('.lane.video .clip').first();
  const box = (await video.boundingBox())!;
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const trimmed = (await clips(page)).find((c) => c.start === 0 && c.out < 3.9 && c.out > 2.5);
  expect(trimmed, 'video clip was trimmed').toBeTruthy();
  await page.keyboard.press('Control+z');

  // Export.
  await page.keyboard.press('Control+e');
  const download = page.waitForEvent('download');
  await page.locator('.modal-foot button.primary').click();
  const file = join(MEDIA_DIR, 'export.mp4');
  await (await download).saveAs(file);
  await expect(page.locator('.success-text')).toBeVisible({ timeout: 60_000 });
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file]).toString();
  const info = JSON.parse(probe);
  expect(info.streams.map((s: { codec_type: string }) => s.codec_type).sort()).toEqual(['audio', 'video']);
  expect(Number(info.format.duration)).toBeGreaterThan(8.8);
  expect(Number(info.format.duration)).toBeLessThan(9.3);
  await page.locator('.modal-foot button.primary').click();

  // Autosave survives a reload; media dropped without file handles must be reconnected.
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('.clip')).toHaveCount(3);
  await expect(page.locator('.warning-bar')).toBeVisible();

  expect(errors).toEqual([]);
});
