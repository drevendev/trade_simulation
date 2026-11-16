/** #677 / #1073: Chromium smoke over the ACTUAL published M5 story. */
import { chromium } from "playwright";

// The preceding asset gate compares these same URLs with the exact deployed
// commit. This browser gate checks that visitors can actually read the story.
const LIVE_URL = "https://drevendev.github.io/trade_simulation/m5.html";
const widths = [320, 360, 1280];

async function problemsOnPage(page) {
  return page.evaluate(() => {
    const problems = [];
    const viewport = window.innerWidth;
    if (document.documentElement.scrollWidth > viewport + 1 ||
        document.body.scrollWidth > viewport + 1) {
      problems.push("whole-page horizontal overflow");
    }
    const targets = [
      ["#status", 14], ["#arrival-status", 14],
      ["#routes article h3", 14], ["#routes article .stat strong", 14],
      ["#routes article li", 14], ["#arrival-routes article h3", 14],
      ["#arrival-routes article .stat strong", 14],
      ["#arrival-routes article li", 14], ["#fx article h3", 14],
      ["#fx article .stat strong", 14],
    ];
    for (const [selector, minimumPx] of targets) {
      const elements = [...document.querySelectorAll(selector)];
      if (elements.length === 0) problems.push(`missing ${selector}`);
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (!element.textContent?.trim() || rect.width < 1 || rect.height < 1 ||
            rect.left < -1 || rect.right > viewport + 1 ||
            parseFloat(style.fontSize) < minimumPx) {
          problems.push(`unreadable ${selector}`);
        }
        for (let parent = element; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent);
          if (css.visibility !== "visible" || css.display === "none" ||
              Number(css.opacity) <= 0.01) {
            problems.push(`hidden ${selector}`);
            break;
          }
          if (parent === element) continue;
          const box = parent.getBoundingClientRect();
          if ((["hidden", "clip", "auto", "scroll"].includes(css.overflowX) &&
               (rect.left < box.left + parent.clientLeft - 1 ||
                rect.right > box.left + parent.clientLeft + parent.clientWidth + 1)) ||
              (["hidden", "clip", "auto", "scroll"].includes(css.overflowY) &&
               (rect.top < box.top + parent.clientTop - 1 ||
                rect.bottom > box.top + parent.clientTop + parent.clientHeight + 1))) {
            problems.push(`clipped ${selector}`);
            break;
          }
        }
      }
    }
    return problems;
  });
}

const browser = await chromium.launch({ headless: true });
try {
  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      serviceWorkers: "block",
      extraHTTPHeaders: { "Cache-Control": "no-cache" },
    });
    try {
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      const response = await page.goto(LIVE_URL, {
        waitUntil: "domcontentloaded", timeout: 30_000,
      });
      if (!response || response.status() !== 200 || page.url() !== LIVE_URL) {
        throw new Error(`live M5 HTML not served exactly: ${response?.status()} ${page.url()}`);
      }
      await page.waitForFunction(() => {
        const status = document.getElementById("status")?.textContent || "";
        const arrival = document.getElementById("arrival-status")?.textContent || "";
        return !status.includes("Loading") && !arrival.includes("Loading");
      }, undefined, { timeout: 30_000 });
      const summary = await page.locator("#status").innerText();
      const arrival = await page.locator("#arrival-status").innerText();
      if (!summary.includes("source-backed data loaded") ||
          !arrival.includes("delivered shipment") || pageErrors.length) {
        throw new Error(`live M5 evidence absent at ${width}px: ${summary}; ${arrival}; ${pageErrors}`);
      }
      const problems = await problemsOnPage(page);
      if (problems.length) throw new Error(`live M5 ${width}px: ${problems.join("; ")}`);
      // Negative control: hiding routes must fail even when all text remains
      // in the DOM and document scrollWidth remains within the viewport.
      await page.addStyleTag({ content: "#routes { visibility: hidden !important; }" });
      if (!(await problemsOnPage(page)).some(item => item.startsWith("hidden #routes"))) {
        throw new Error(`live M5 ${width}px: hidden route escaped detection`);
      }
      console.log(`Live M5 Chromium ${width}px: PASS (dispatch, arrival and FX)`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
