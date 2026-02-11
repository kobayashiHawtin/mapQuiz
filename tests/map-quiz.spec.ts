import { expect, test } from '@playwright/test'

const GEO_DATA_URL =
  'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson'

const geoFixture = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        ADMIN: 'Japan',
        ISO_A3: 'JPN',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-120, 60],
            [120, 60],
            [120, -20],
            [-120, -20],
            [-120, 60],
          ],
        ],
      },
    },
  ],
}

const hintFixture = {
  main_hint: 'テスト用のヒントです。',
  summary: 'テストヒント',
}

test.beforeEach(async ({ page }) => {
  await page.route(GEO_DATA_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(geoFixture),
    }),
  )
  await page.route(/generativelanguage\.googleapis\.com\/v1beta\/models\/.*:generateContent\?key=/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify(hintFixture) }],
            },
          },
        ],
      }),
    }),
  )
})

test('start game and answer correctly', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: /geomind/i })).toBeVisible()
  await page.getByRole('button', { name: /start game/i }).click()

  await expect(page.getByText(/region data analysis/i)).toBeVisible()
  await expect(page.getByText(/Pinch\/Scroll to Zoom/i)).toBeVisible()

  const paths = page.locator('svg[viewBox="0 0 800 400"] path')
  await expect(paths).toHaveCount(1)
  await paths.first().click()

  await expect(page.getByText('SUCCESS')).toBeVisible()
  await expect(page.getByText('正解！')).toBeVisible()
})
