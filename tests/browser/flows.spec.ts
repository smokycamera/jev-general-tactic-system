import { expect, test } from '@playwright/test';
test('tactical preferences show execution dependencies and missing-mechanic fallback', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#manual-action option')).not.toHaveCount(0);
  await page.locator('.tactical-settings summary').click();
  await expect(page.locator('#doctrine optgroup')).toHaveCount(5);
  await expect(page.locator('#doctrine option')).toHaveCount(34);
  await expect(page.locator('#doctrine option[value="search-contact"]')).toHaveText('搜索接触');
  await page.locator('#doctrine').selectOption('fire-then-assault');
  await page.getByLabel('烟幕与遮蔽', { exact: true }).check();
  await page.getByLabel('火力压制', { exact: true }).check();
  await page.getByRole('button', { name: '应用指挥设置' }).click();
  await expect(page.locator('#notice')).toHaveText('指挥设置已保存。');
  await page.getByRole('button', { name: '单步', exact: true }).click();
  await expect(page.locator('#tasks')).toContainText('火力准备后突击');
  await expect(page.locator('#tasks')).toContainText('烟幕与遮蔽：当前机制或兵力不支持');
  await page.locator('#tasks .network summary').first().click();
  await expect(page.locator('#tasks .network').first()).toContainText('火力准备');
  await expect(page.locator('#tasks .network').first()).toContainText('交战');
});
test('zero dialogs: plan, pause, single step, tune, revise and finish', async ({ page }) => {
  let dialogs = 0;
  const errors: string[] = [];
  page.on('dialog', async (d) => {
    dialogs++;
    await d.dismiss();
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让计划持续推进。' })).toBeVisible();
  await expect(page.locator('#manual-action option')).not.toHaveCount(0);
  await page.getByRole('button', { name: '单步', exact: true }).click();
  await expect(page.locator('#actions')).toHaveText('1');
  await expect(page.locator('#tasks .task')).toHaveCount(2);
  await page.locator('#ability').selectOption('master');
  await page.locator('#style-flank').focus();
  await page.keyboard.press('End');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: '应用指挥设置' }).click();
  await expect(page.locator('#notice')).toHaveText('指挥设置已保存。');
  await page.locator('#goal-target').selectOption('7,3');
  await page.getByRole('button', { name: '更新目标' }).click();
  await page.getByRole('button', { name: '单步', exact: true }).click();
  await expect(page.locator('#goals')).toContainText('手动指定');
  await page.getByRole('button', { name: '自动运行', exact: true }).click();
  await expect(page.locator('#actions')).not.toHaveText('2');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.locator('#status-text')).toHaveText('已暂停');
  const count = await page.locator('#actions').innerText();
  await page.getByRole('button', { name: '单步', exact: true }).click();
  await expect(page.locator('#actions')).toHaveText(String(Number(count) + 1));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/jev-.*\.json/);
  await page.getByRole('button', { name: '自动运行', exact: true }).click();
  await expect(page.locator('#status-text')).toHaveText('战斗结束', { timeout: 25000 });
  expect(dialogs).toBe(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/commander-desktop.png', fullPage: true });
});
test('mobile region map stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#manual-action option')).not.toHaveCount(0);
  await page.getByLabel('示例地图').selectOption('regions');
  await page.getByRole('button', { name: '新建战斗', exact: true }).click();
  await expect(page.locator('#map-caption')).toContainText('区域之间');
  await page.getByRole('button', { name: '单步', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/commander-mobile.png', fullPage: true });
});
test('pause remains available while an earlier request is awaiting its response', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#manual-action option')).not.toHaveCount(0);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/step', async (route) => {
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '单步', exact: true }).click();
  await started;
  const paused = page.waitForResponse((response) => response.url().endsWith('/pause'), {
    timeout: 3000,
  });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  try {
    expect((await paused).ok()).toBe(true);
  } finally {
    release();
  }
  await expect(page.locator('#status-text')).toHaveText('已暂停');
});
