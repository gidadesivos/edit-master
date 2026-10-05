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

const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__EDIT_MASTER__.useEditor.getState();
    return { clips: Object.values(s.project.clips) as any[], selection: s.selection as string[] };
  });

const seek = async (page: Page, t: number) => {
  await page.evaluate((t) => (window as any).__EDIT_MASTER__.useEditor.getState().setPlayhead(t), t);
  await page.waitForTimeout(500);
};

/** RGB of the preview canvas at a relative position. */
const pixel = (page: Page, fx: number, fy: number) =>
  page.evaluate(([fx, fy]) => {
    const c = document.querySelector<HTMLCanvasElement>('.stage canvas')!;
    return [...c.getContext('2d')!.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data.slice(0, 3)];
  }, [fx, fy]);

const isOrange = ([r, g, b]: number[]) => r > 220 && g > 130 && g < 200 && b < 60;
const isGray = ([r, g, b]: number[]) => Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) < 12;

/** Selects a clip on the timeline by its id (clicks its element). */
async function selectClip(page: Page, index: number, laneSelector = '.lane.video .clip') {
  await page.locator(laneSelector).nth(index).click({ position: { x: 20, y: 30 } });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/__media/*', (r) => r.fulfill({ body: readFileSync(join(MEDIA_DIR, r.request().url().split('/').pop()!)) }));
  await page.addInitScript(() => {
    (window as any).showSaveFilePicker = undefined;
  });
  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();
});

test('phase 2: text, filter, keyframes, speed, transition and export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await dropFiles(page, ['clip.webm', 'square.png']);
  await expect(page.locator('.asset')).toHaveCount(2);
  await page.locator('.asset', { hasText: 'clip.webm' }).dblclick(); // [0,4]
  await page.locator('.asset', { hasText: 'square.png' }).dblclick(); // [4,9]
  await expect(page.locator('.clip')).toHaveCount(2);

  // --- Filter: black & white on the video ---
  await selectClip(page, 0);
  await page.getByRole('tab', { name: 'Filtros' }).click();
  await page.locator('.preset', { hasText: 'P&B' }).click();
  await seek(page, 1);
  expect(isGray(await pixel(page, 0.3, 0.3)), 'video is grayscale').toBe(true);

  // --- Keyframes: scale 1 at 0s → 0.1 at 3s ---
  await page.getByRole('tab', { name: 'Básico' }).click();
  await seek(page, 0);
  await page.locator('.field', { hasText: 'Escala' }).locator('.kf-btn').click();
  await seek(page, 3);
  const scale = page.locator('.field', { hasText: 'Escala' }).locator('input[type=range]');
  await scale.focus();
  await page.keyboard.press('Home'); // minimum = 10%
  await page.locator('.stage').click(); // blur the slider
  const kf = (await state(page)).clips.find((c) => c.assetId && c.keyframes.scale)!;
  expect(kf.keyframes.scale.map((k: any) => [Math.round(k.t * 10) / 10, k.v])).toEqual([[0, 1], [3, 0.1]]);
  await seek(page, 0.05);
  expect(await pixel(page, 0.3, 0.3)).not.toEqual([0, 0, 0]);
  await seek(page, 3);
  expect(await pixel(page, 0.3, 0.3)).toEqual([0, 0, 0]); // shrunk: edges show the background
  expect(await page.locator('.kf-mark').count()).toBe(2);

  // --- Speed 2x: video becomes 2s, the image ripples to 2s ---
  await page.getByRole('tab', { name: 'Velocidade' }).click();
  await page.locator('.chip', { hasText: /^2x$/ }).click();
  let clips = (await state(page)).clips;
  const vid = clips.find((c) => c.speed === 2)!;
  const img = clips.find((c) => c.id !== vid.id)!;
  expect(img.start).toBeCloseTo(2);
  expect(vid.keyframes.scale.at(-1).t).toBeCloseTo(1.5); // keyframes follow the speed change

  // --- Transition into the image ---
  await selectClip(page, 1);
  await page.getByRole('tab', { name: 'Transição' }).click();
  await page.locator('.preset', { hasText: 'Deslizar ←' }).click();
  clips = (await state(page)).clips;
  expect(clips.find((c) => c.id === img.id)!.transitionIn).toMatchObject({ type: 'slide-left', duration: 0.5 });
  await seek(page, 2.25); // halfway: image slides in from the right
  expect(isOrange(await pixel(page, 0.85, 0.5)), 'incoming image on the right').toBe(true);
  await seek(page, 3);
  expect(isOrange(await pixel(page, 0.5, 0.5))).toBe(true);

  // --- Text ---
  await seek(page, 0.5);
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  await expect(page.locator('.clip.text')).toHaveCount(1);
  const area = page.locator('textarea.text-input');
  await area.fill('OLÁ MUNDO');
  await page.locator('.preset', { hasText: 'Amarelo' }).click();
  await seek(page, 1.5);
  const textPixels = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.stage canvas')!;
    const d = c.getContext('2d')!.getImageData(0, Math.floor(c.height * 0.4), c.width, Math.floor(c.height * 0.2)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 190 && d[i + 2] < 60) n++; // #ffd60a
    return n;
  });
  expect(textPixels, 'yellow text drawn').toBeGreaterThan(200);
  // Undo restores the previous text style, redo reapplies it.
  await page.locator('.stage').click();
  await page.keyboard.press('Control+z');
  expect((await state(page)).clips.find((c) => c.kind === 'text').text.color).toBe('#ffffff');
  await page.keyboard.press('Control+Shift+z');
  expect((await state(page)).clips.find((c) => c.kind === 'text').text.content).toBe('OLÁ MUNDO');

  await page.screenshot({ path: 'test-results/phase2-editor.png' });

  // --- Export ---
  await page.keyboard.press('Control+e');
  const download = page.waitForEvent('download');
  await page.locator('.modal-foot button.primary').click();
  const file = join(MEDIA_DIR, 'phase2.mp4');
  await (await download).saveAs(file);
  await expect(page.locator('.success-text')).toBeVisible({ timeout: 60_000 });

  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
  expect(duration).toBeGreaterThan(6.9);
  expect(duration).toBeLessThan(7.2);
  const framePixel = (t: number, fx: number, fy: number) => {
    const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:iw*${fx}:ih*${fy},format=rgb24`, '-f', 'rawvideo', '-']);
    return [...raw.subarray(0, 3)];
  };
  expect(isGray(framePixel(0.3, 0.3, 0.3)), 'export: grayscale video').toBe(true);
  expect(isOrange(framePixel(2.25, 0.85, 0.5)), 'export: transition').toBe(true);
  expect(isOrange(framePixel(5, 0.5, 0.65)), 'export: image').toBe(true);

  expect(errors).toEqual([]);
});
