import { devices, expect, test, type Page } from "@playwright/test";

const openSample = (page: Page) => page.goto("/?demo=1");
const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();

test.describe("sample workspace", () => {
  test("labels itself and never contacts the live API", async ({ page }) => {
    const live: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/(dashboard|prs|sync|repos|runs|findings)/.test(request.url())) live.push(request.url());
    });

    await openSample(page);
    await expect(page.getByRole("note")).toHaveText(/read-only sample/);
    for (const name of ["Repositories", "Pull requests", "Findings", "Operations", "Settings", "Overview"]) {
      await nav(page, name);
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    }
    expect(live).toEqual([]);
  });

  test("offers no actions that change anything", async ({ page }) => {
    await openSample(page);
    await nav(page, "Repositories");
    await expect(page.getByRole("button", { name: /^Pause/ })).toHaveCount(0);
    await nav(page, "Operations");
    await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
    await nav(page, "Settings");
    await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
    await nav(page, "Findings");
    await page.getByRole("button", { name: "Timeout path has no test" }).click();
    await expect(page.getByRole("button", { name: "Confirm fix" })).toHaveCount(0);
  });

  test("searches and filters pull requests", async ({ page }) => {
    await openSample(page);
    await nav(page, "Pull requests");
    await expect(page.getByRole("row")).toHaveCount(4);

    await page.getByLabel("Search").fill("cache");
    await expect(page.getByRole("row")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Cache repository lookups" })).toBeVisible();

    await page.getByLabel("Search").fill("");
    await page.getByLabel("Latest review").selectOption("failed");
    await expect(page.getByRole("button", { name: "Upgrade the invoice export" })).toBeVisible();

    await page.getByLabel("Search").fill("no such thing");
    await expect(page.getByText("No matches")).toBeVisible();
  });

  test("shows run and finding detail in a drawer that Escape closes", async ({ page }) => {
    await openSample(page);
    await nav(page, "Pull requests");
    await page.getByRole("button", { name: "Add retry to payment webhook handler" }).click();

    const drawer = page.getByRole("dialog");
    await expect(drawer).toContainText("sample-org/payments #42");
    await expect(drawer).toContainText("Retried webhook can charge a customer twice");
    await expect(drawer).toContainText("4 files of 4 reviewed");

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  test("filters findings by category and outcome", async ({ page }) => {
    await openSample(page);
    await nav(page, "Findings");
    await page.getByLabel("Category").selectOption("security");
    await expect(page.getByRole("button", { name: "Cache key ignores the signed-in user" })).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(2);

    await page.getByLabel("Code outcome").selectOption("open");
    await expect(page.getByText("No matches")).toBeVisible();
  });

  test("returns to sign-in when leaving the sample", async ({ page }) => {
    await openSample(page);
    await page.getByRole("button", { name: "Leave sample" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to Reviewgate" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test("opens from the sign-in screen", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "View a sample workspace" }).click();
    await expect(page.getByRole("note")).toHaveText(/read-only sample/);
  });
});

test.describe("phone layout", () => {
  const { defaultBrowserType: _ignored, ...phone } = devices["iPhone 13"];
  test.use(phone);

  test("does not scroll sideways on any screen", async ({ page }) => {
    await openSample(page);
    for (const name of ["Overview", "Repositories", "Pull requests", "Findings", "Operations", "Settings"]) {
      await nav(page, name);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, name).toBe(0);
    }
  });
});

test.describe("live workspace boundary", () => {
  test("shows sign-in and no workspace data when signed out", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in to Reviewgate" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  });

  test("rejects unauthenticated API reads", async ({ request }) => {
    expect((await request.get("/api/dashboard")).status()).toBe(401);
    expect((await request.get("/api/prs/1%3A1")).status()).toBe(401);
  });

  test("explains a failed sign-in", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText(/don't match/);
  });
});
