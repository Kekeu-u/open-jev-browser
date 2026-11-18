// Abre o Chrome REAL (visível) e pesquisa "abacaxi" no Bing.
// Roda de dentro de jev-browser/ para achar o playwright local.
import { chromium } from "playwright";

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--start-maximized"],
});
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
await page.goto("https://www.bing.com/", { waitUntil: "domcontentloaded" });
console.log("URL antes:", page.url());

const campo = page.locator("#sb_form_q");
await campo.click();
await campo.pressSequentially("abacaxi", { delay: 120 });   // digita como humano
console.log("digitado:", await campo.inputValue());
await campo.press("Enter");
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("#b_results li.b_algo", { timeout: 20000 }).catch(() => {});
console.log("URL depois:", page.url());
console.log("titulo:", await page.title());
const titulos = await page.$$eval("#b_results h2 a", (as) => as.slice(0, 5).map((a) => a.textContent.trim()));
console.log("resultados:", JSON.stringify(titulos, null, 1));
await page.screenshot({ path: "C:/apps/abacaxi-chrome-real.png", fullPage: false });
console.log("print: C:/apps/abacaxi-chrome-real.png");
console.log("janela fica aberta — feche quando quiser.");
// Não fecha o browser: a janela continua na tela para você ver.
