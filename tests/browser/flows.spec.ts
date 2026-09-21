import { expect, test } from '@playwright/test';
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
  await expect(page.locator('#tasks .task')).toHaveCount(3);
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
  await page.getByLabel('示例地图').selectOption('regions');
  await page.getByRole('button', { name: '新建战斗', exact: true }).click();
  await expect(page.locator('#map-caption')).toContainText('区域之间');
  await page.getByRole('button', { name: '单步', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/commander-mobile.png', fullPage: true });
});
