'use strict';

/**
 * Single non-blocking poll iteration for Playwright table rows.
 * Checks row.count() before textContent({ timeout }) and bounds drawer/refresh clicks
 * so unmounted rows or transient Ant Design drawer masks never stall expect.poll for 45s.
 */
async function runNonBlockingRowPollStep({
  row,
  refreshBtn,
  drawerCloseBtn,
  expectedText,
  readTimeoutMs = 800,
  clickTimeoutMs = 1500,
}) {
  const readRowText = async () => {
    const count = await row.count().catch(() => 0);
    if (count === 0) return '';
    return (
      (await row
        .first()
        .textContent({ timeout: readTimeoutMs })
        .catch(() => '')) ?? ''
    );
  };

  const beforeRefresh = await readRowText();
  if (beforeRefresh.includes(expectedText)) {
    return beforeRefresh;
  }

  if (drawerCloseBtn && (await drawerCloseBtn.isVisible().catch(() => false))) {
    await drawerCloseBtn.click({ timeout: clickTimeoutMs }).catch(() => undefined);
  }

  if (await refreshBtn.isVisible().catch(() => false)) {
    await refreshBtn.click({ timeout: clickTimeoutMs }).catch(() => undefined);
  }

  return readRowText();
}

module.exports = { runNonBlockingRowPollStep };
