import { test, expect } from "@playwright/test";

test.describe("authentication flow", () => {
  test("admin user can sign in and view the account badge", async ({ page }) => {
    await page.goto("http://localhost:3000/login");

    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL("http://localhost:3000/dashboard");
    await expect(page.getByText("Signed in successfully.")).toBeVisible();
    await expect(page.getByTestId("role-badge")).toHaveText("admin");
  });

  test("locked accounts see a blocking error message", async ({ page }) => {
    await page.goto("http://localhost:3000/login");

    await page.getByLabel("Email").fill("sam@example.com");
    await page.getByLabel("Password").fill("sunrise");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Account is locked.")).toBeVisible();
    await expect(page).toHaveURL("http://localhost:3000/login");
  });
});
